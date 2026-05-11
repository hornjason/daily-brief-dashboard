import { useEffect } from 'react'
import { X, ExternalLink, AlertTriangle, FileText, Presentation } from 'lucide-react'

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

type PanelFeature = ProductFeature & {
  productSlug: string
  productDisplayName: string
  isNew: boolean
}

const PRODUCT_RELEASE_NOTES: Record<string, string> = {
  'rhel': 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/',
  'ocp': 'https://docs.redhat.com/en/documentation/openshift_container_platform/',
  'ocp-virt': 'https://docs.redhat.com/en/documentation/openshift_container_platform/',
  'aap': 'https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/',
  'rhel-ai': 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux_ai/',
  'rh-ai-inference': 'https://docs.redhat.com/en/documentation/red_hat_ai_inference_server/',
  'rhoai': 'https://docs.redhat.com/en/documentation/red_hat_openshift_ai_self-managed/',
}

interface FeatureDetailPanelProps {
  feature: PanelFeature | null
  onClose: () => void
  onTagClick: (tag: string) => void
}

const statusStyles: Record<string, string> = {
  'GA':           'bg-green-500/20 text-green-400 border border-green-500/40',
  'Tech Preview': 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
  'Roadmap':      'bg-blue-500/20 text-blue-400 border border-blue-500/40',
  'Deprecated':   'bg-gray-500/20 text-gray-400 border border-gray-500/40',
}

export function FeatureDetailPanel({ feature, onClose, onTagClick }: FeatureDetailPanelProps) {
  useEffect(() => {
    if (!feature) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [feature, onClose])

  if (!feature) return null

  const badgeClass = statusStyles[feature.status] ?? statusStyles['GA']
  const displayText = feature.enrichedDescription ?? feature.description

  // Construct Learn More URL (priority order):
  // 1. feature.sourceUrls[0] if available (AI-extracted docs links)
  // 2. feature.enrichmentUrls[0] if available (fetched during enrichment)
  // 3. Product release notes page (known docs.redhat.com URL per product)
  const primaryUrl =
    feature.sourceUrls.find(u => /^https?:\/\//.test(u)) ??
    feature.enrichmentUrls.find(u => /^https?:\/\//.test(u)) ??
    PRODUCT_RELEASE_NOTES[feature.productSlug] ??
    null

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 w-[420px] bg-surface border-l border-border shadow-2xl z-50 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border shrink-0">
          <div className="flex-1 min-w-0">
            {/* Product badge + status */}
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              <span className="text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded font-medium">
                {feature.productDisplayName}
              </span>
              {feature.isNew && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/40">
                  New
                </span>
              )}
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${badgeClass}`}>
                {feature.status}
              </span>
            </div>
            {/* Feature name */}
            <h2 className="text-sm font-semibold text-text-primary leading-snug">
              {feature.name}
            </h2>
            {/* Version */}
            {feature.versionIntroduced && (
              <span className="inline-block mt-1.5 bg-surface-hover border border-border text-[10px] font-mono text-text-secondary px-2 py-0.5 rounded-full">
                v{feature.versionIntroduced}
                {feature.versionCurrent && feature.versionCurrent !== feature.versionIntroduced
                  ? ` - v${feature.versionCurrent}`
                  : ''}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 p-1 rounded hover:bg-surface-hover text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Close panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {/* Description */}
          <p className="text-sm text-text-secondary leading-relaxed">{displayText}</p>

          {/* Tags */}
          {feature.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {feature.tags.map(tag => (
                <button
                  key={tag}
                  onClick={() => { onTagClick(tag); onClose() }}
                  className="text-[10px] bg-surface-hover text-text-secondary px-2 py-0.5 rounded hover:bg-accent/20 hover:text-accent transition-colors"
                >
                  {tag}
                </button>
              ))}
            </div>
          )}

          {/* Confidence warning */}
          {feature.confidence === 'LOW' && (
            <div className="flex items-center gap-2 text-xs text-yellow-500 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>Source confidence LOW — verify before citing in customer conversations.</span>
            </div>
          )}

          {/* Source indicator */}
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            {feature.releaseNotesSection
              ? <FileText className="w-3.5 h-3.5 shrink-0" />
              : <Presentation className="w-3.5 h-3.5 shrink-0" />
            }
            <span>
              {feature.releaseNotesSection
                ? `From release notes: ${feature.releaseNotesSection}`
                : `From slide deck: ${feature.slideSource}`
              }
            </span>
          </div>

          {/* Learn More link */}
          {primaryUrl && (
            <a
              href={primaryUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-accent hover:underline"
            >
              <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              Learn More
            </a>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border shrink-0 flex flex-col gap-0.5">
          {feature.releaseNotesSection && (
            <p className="text-[10px] text-text-secondary">
              From release notes: {feature.releaseNotesSection}
            </p>
          )}
          {!feature.releaseNotesSection && (
            <p className="text-[10px] text-text-secondary">From slide deck</p>
          )}
        </div>
      </div>
    </>
  )
}
