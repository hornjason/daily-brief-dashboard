// TODO: Phase 3 — feature radar (see issue #9)
import { ExternalLink, AlertTriangle, FileText, Presentation } from 'lucide-react'

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

interface FeatureCardProps {
  feature: ProductFeature
  onTagClick?: (tag: string) => void
  isNew?: boolean
}

const statusStyles: Record<string, string> = {
  'GA':           'bg-green-500/20 text-green-400 border border-green-500/40',
  'Tech Preview': 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
  'Roadmap':      'bg-blue-500/20 text-blue-400 border border-blue-500/40',
  'Deprecated':   'bg-gray-500/20 text-gray-400 border border-gray-500/40',
}

export function FeatureCard({ feature, onTagClick, isNew }: FeatureCardProps) {
  const badgeClass = statusStyles[feature.status] ?? statusStyles['GA']
  const displayText = feature.enrichedDescription ?? feature.description
  const primaryUrl = feature.sourceUrls.find(u => /^https?:\/\//.test(u))
    ?? feature.enrichmentUrls.find(u => /^https?:\/\//.test(u))
    ?? null

  return (
    <div className={`bg-surface border border-border rounded-xl p-4 flex flex-col gap-2.5${feature.status === 'Tech Preview' ? ' border-l-[3px] border-l-amber-500' : ''}`}>
      {/* Header row: name + status badge */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        {isNew && (
          <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/40">
            New
          </span>
        )}
        <h4 className="text-sm font-semibold text-text-primary leading-tight">{feature.name}</h4>
        <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${badgeClass}`}>
          {feature.status}
        </span>
      </div>

      {/* Version badge */}
      {feature.versionIntroduced && (
        <span className="inline-block w-fit bg-surface-hover text-text-secondary border border-border text-xs px-2 py-0.5 rounded-full font-mono">
          v{feature.versionIntroduced}{feature.versionCurrent && feature.versionCurrent !== feature.versionIntroduced ? ` - v${feature.versionCurrent}` : ''}
        </span>
      )}

      {/* Body */}
      <p className="text-xs text-text-secondary leading-relaxed">{displayText}</p>

      {/* Footer: tags + indicators + learn more */}
      <div className="flex items-end justify-between mt-auto pt-1 gap-2">
        {/* Tags */}
        <div className="flex flex-wrap gap-1">
          {feature.tags.slice(0, 4).map(tag => (
            <button
              key={tag}
              onClick={() => onTagClick?.(tag)}
              className="bg-surface-hover text-text-secondary text-[10px] px-1.5 py-0.5 rounded hover:bg-accent/20 hover:text-accent transition-colors cursor-pointer"
            >
              {tag}
            </button>
          ))}
        </div>

        {/* Confidence + source icon + learn more */}
        <div className="flex items-center gap-1.5 shrink-0">
          {feature.confidence === 'LOW' && (
            <span title="Source confidence: LOW — verify before citing in customer conversations">
              <AlertTriangle className="w-3 h-3 text-yellow-500 shrink-0" />
            </span>
          )}
          <span title={feature.releaseNotesSection ? `From release notes: ${feature.releaseNotesSection}` : `From slide deck: ${feature.slideSource}`}>
            {feature.releaseNotesSection
              ? <FileText className="w-3 h-3 text-text-secondary/50 shrink-0" />
              : <Presentation className="w-3 h-3 text-text-secondary/50 shrink-0" />
            }
          </span>
          {primaryUrl && (
            <a
              href={primaryUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-accent hover:underline shrink-0"
            >
              <ExternalLink className="w-3 h-3" />
              Learn more
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
