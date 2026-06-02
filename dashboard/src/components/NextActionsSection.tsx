/**
 * NextActionsSection — Landing page "Next Actions" card section
 * GitHub Issue #547
 *
 * Fetches action triggers from GET /api/action-triggers and displays
 * the top 3-5 as compact cards. Hidden entirely when no triggers exist
 * or when the API is unavailable.
 */
import { useEffect, useState } from 'react'
import { Target } from 'lucide-react'

interface ActionTrigger {
  customerName: string
  urgency: 'critical' | 'high' | 'medium'
  trigger: string
  suggestedAction: string
  motionTitle?: string
}

interface ActionTriggersResponse {
  triggers: ActionTrigger[]
}

const urgencyStyles: Record<ActionTrigger['urgency'], { bg: string; text: string; label: string }> = {
  critical: { bg: 'bg-red-500/15', text: 'text-red-400', label: 'Critical' },
  high:     { bg: 'bg-amber-500/15', text: 'text-amber-400', label: 'High' },
  medium:   { bg: 'bg-green-500/15', text: 'text-green-400', label: 'Medium' },
}

function UrgencyBadge({ urgency }: { urgency: ActionTrigger['urgency'] }) {
  const style = urgencyStyles[urgency]
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${style.bg} ${style.text} font-medium`}>
      <span className={`w-1.5 h-1.5 rounded-full ${urgency === 'critical' ? 'bg-red-400' : urgency === 'high' ? 'bg-amber-400' : 'bg-green-400'}`} />
      {style.label}
    </span>
  )
}

function SkeletonCard() {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 animate-pulse">
      <div className="flex items-center gap-2 mb-2">
        <div className="h-4 w-32 bg-border rounded" />
        <div className="h-5 w-16 bg-border rounded-full" />
      </div>
      <div className="h-3.5 w-full bg-border rounded mb-1.5" />
      <div className="h-3.5 w-3/4 bg-border rounded" />
    </div>
  )
}

export function NextActionsSection() {
  const [triggers, setTriggers] = useState<ActionTrigger[]>([])
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function fetchTriggers() {
      try {
        const res = await fetch('/api/action-triggers')
        if (!res.ok) {
          // API not available or no triggers — hide section
          if (!cancelled) setHidden(true)
          return
        }
        const data: ActionTriggersResponse = await res.json()
        if (!cancelled) {
          if (!data.triggers?.length) {
            setHidden(true)
          } else {
            setTriggers(data.triggers.slice(0, 5))
          }
        }
      } catch {
        // Network error — hide section silently
        if (!cancelled) setHidden(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchTriggers()
    return () => { cancelled = true }
  }, [])

  // Hidden entirely when no triggers or API unavailable
  if (hidden && !loading) return null

  // Loading state: show skeleton cards
  if (loading) {
    return (
      <section aria-label="Next Actions">
        <div className="flex items-center gap-2 mb-3">
          <Target className="w-4 h-4 text-accent" />
          <h3 className="text-base font-semibold text-text-primary">Next Actions</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </section>
    )
  }

  return (
    <section aria-label="Next Actions">
      <div className="flex items-center gap-2 mb-3">
        <Target className="w-4 h-4 text-accent" />
        <h3 className="text-base font-semibold text-text-primary">Next Actions</h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {triggers.map((trigger, i) => (
          <div
            key={`${trigger.customerName}-${i}`}
            className="bg-surface border border-border rounded-xl p-4 hover:border-accent/40 transition-colors"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <a
                href={`/dashboard/customer/${encodeURIComponent(trigger.customerName)}`}
                className="text-sm font-semibold text-accent hover:underline truncate"
              >
                {trigger.customerName}
              </a>
              <UrgencyBadge urgency={trigger.urgency} />
            </div>
            <p className="text-sm text-text-secondary leading-snug line-clamp-1">
              {trigger.trigger}
            </p>
            <p className="text-sm text-text-primary leading-snug mt-1 line-clamp-1">
              {trigger.suggestedAction}
            </p>
            {trigger.motionTitle && (
              <p className="text-xs text-text-secondary/60 mt-1.5 truncate">
                {trigger.motionTitle}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
