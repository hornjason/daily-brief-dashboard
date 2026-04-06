import { useMemo } from 'react'

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

type SpotlightFeature = ProductFeature & {
  productSlug: string
  productShortName: string
  isNew: boolean
}

interface SpotlightStripProps {
  features: SpotlightFeature[]
  onSelect: (f: ProductFeature & { productSlug: string; isNew: boolean }) => void
}

const statusStyles: Record<string, string> = {
  'GA':           'bg-green-500/20 text-green-400 border border-green-500/40',
  'Tech Preview': 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
  'Roadmap':      'bg-blue-500/20 text-blue-400 border border-blue-500/40',
  'Deprecated':   'bg-gray-500/20 text-gray-400 border border-gray-500/40',
}

function scoreFeature(f: SpotlightFeature): number {
  let score = 0
  if (f.isNew) score += 100
  if (f.status === 'Tech Preview') score += 50
  if (f.status === 'Roadmap') score += 30
  if (f.status === 'GA') score += 10
  return score
}

export function SpotlightStrip({ features, onSelect }: SpotlightStripProps) {
  const topFeatures = useMemo(() => {
    return [...features]
      .sort((a, b) => {
        const diff = scoreFeature(b) - scoreFeature(a)
        if (diff !== 0) return diff
        return a.id.localeCompare(b.id)
      })
      .slice(0, 5)
  }, [features])

  if (topFeatures.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-text-secondary font-medium uppercase tracking-wide">Spotlight</span>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {topFeatures.map(f => {
          const badgeClass = statusStyles[f.status] ?? statusStyles['GA']
          return (
            <div
              key={f.id}
              onClick={() => onSelect(f)}
              className="min-w-[220px] max-w-[260px] bg-surface border border-border rounded-xl p-3 cursor-pointer hover:border-accent/40 transition-colors flex flex-col gap-1.5 shrink-0"
            >
              {/* Top row: product badge + new pill + status badge */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="bg-accent/10 text-accent text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0">
                  {f.productShortName}
                </span>
                {f.isNew && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/40 shrink-0">
                    New
                  </span>
                )}
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${badgeClass}`}>
                  {f.status}
                </span>
              </div>

              {/* Feature name */}
              <p className="text-sm font-semibold text-text-primary leading-snug line-clamp-2">
                {f.name}
              </p>

              {/* Version */}
              {f.versionIntroduced && (
                <span className="text-[10px] text-text-secondary font-mono">
                  v{f.versionIntroduced}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
