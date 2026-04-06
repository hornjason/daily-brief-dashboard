import { ChevronRight } from 'lucide-react'

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

interface FeatureListRowProps {
  feature: ProductFeature
  isNew: boolean
  onSelect: () => void
  onTagClick: (tag: string) => void
}

const statusBadge: Record<string, string> = {
  'GA':           'bg-green-500/20 text-green-400',
  'Tech Preview': 'bg-amber-500/20 text-amber-400',
  'Roadmap':      'bg-blue-500/20 text-blue-400',
  'Deprecated':   'bg-gray-500/20 text-gray-400',
}

export function FeatureListRow({ feature, isNew, onSelect, onTagClick }: FeatureListRowProps) {
  const badge = statusBadge[feature.status] ?? statusBadge['GA']
  const accentBar = feature.status === 'Tech Preview' ? 'bg-amber-500' : 'bg-transparent'

  return (
    <div
      onClick={onSelect}
      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-hover cursor-pointer transition-colors group"
    >
      {/* Left accent bar */}
      <span className={`w-0.5 h-5 rounded-full shrink-0 ${accentBar}`} />

      {/* Status badge */}
      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${badge}`}>
        {feature.status}
      </span>

      {/* New pill */}
      {isNew && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/40 shrink-0">
          New
        </span>
      )}

      {/* Feature name */}
      <span className="text-sm text-text-primary font-medium flex-1 truncate min-w-0">
        {feature.name}
      </span>

      {/* Version */}
      {feature.versionIntroduced && (
        <span className="text-xs text-text-secondary font-mono shrink-0 hidden sm:block">
          v{feature.versionIntroduced}
        </span>
      )}

      {/* First tag */}
      {feature.tags[0] && (
        <button
          onClick={e => { e.stopPropagation(); onTagClick(feature.tags[0]) }}
          className="text-[10px] bg-surface-hover text-text-secondary px-1.5 py-0.5 rounded cursor-pointer hover:text-accent shrink-0 hidden lg:block"
        >
          {feature.tags[0]}
        </button>
      )}

      {/* Arrow */}
      <ChevronRight className="w-3.5 h-3.5 text-text-secondary group-hover:text-accent shrink-0" />
    </div>
  )
}
