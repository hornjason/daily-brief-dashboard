import { useState, useEffect } from 'react'
import { Zap, Calendar, ExternalLink, X } from 'lucide-react'

interface PriorityAction {
  text: string
  severity: 'critical' | 'high' | 'medium'
  source: string
}

interface PriorityActionBannerProps {
  action: PriorityAction | null
  customerName?: string
}

function getDismissKey(customerName: string | undefined, text: string): string {
  const today = new Date().toISOString().slice(0, 10)
  return `pai-dismiss-${customerName ?? 'unknown'}-${today}-${text.slice(0, 40)}`
}

export default function PriorityActionBanner({ action, customerName }: PriorityActionBannerProps) {
  const [dismissed, setDismissed] = useState(false)

  // Check localStorage for prior dismissal on mount
  useEffect(() => {
    if (!action) return
    const key = getDismissKey(customerName, action.text)
    if (localStorage.getItem(key) === '1') {
      setDismissed(true)
    } else {
      setDismissed(false)
    }
  }, [action, customerName])

  if (!action || dismissed) return null

  const borderColor =
    action.severity === 'critical' ? 'border-l-health-red'
    : action.severity === 'high' ? 'border-l-health-amber'
    : 'border-l-accent'

  function handleDismiss() {
    const key = getDismissKey(customerName, action!.text)
    localStorage.setItem(key, '1')
    setDismissed(true)
  }

  function handleSchedule() {
    // Open Google Calendar quick-add with context from the action
    const title = encodeURIComponent(`Follow up: ${action!.text.slice(0, 60)}`)
    window.open(`https://calendar.google.com/calendar/r/eventedit?text=${title}`, '_blank')
  }

  function handleView() {
    // Navigate to the source -- source text contains the context (email, case, meeting)
    const src = action!.source.toLowerCase()
    if (src.includes('case') && src.match(/\d{8,}/)) {
      const caseNum = src.match(/(\d{8,})/)?.[1]
      if (caseNum) {
        window.open(`https://access.redhat.com/support/cases/#/case/${caseNum}`, '_blank')
        return
      }
    }
    // For email/meeting sources, scroll to the activity timeline (fallback)
    const timeline = document.querySelector('[data-section="activity"]')
    if (timeline) {
      timeline.scrollIntoView({ behavior: 'smooth' })
    }
  }

  return (
    <div className={`bg-surface border border-border rounded-xl border-l-[3px] ${borderColor} p-4`}>
      <div className="flex items-start gap-3">
        <Zap className="w-4 h-4 text-accent shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary">{action.text}</p>
          <p className="text-xs text-text-secondary mt-1">Source: {action.source}</p>

          {/* Action buttons */}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={handleSchedule}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent/10 border border-accent/30 text-accent text-xs font-medium hover:bg-accent/20 transition-colors"
            >
              <Calendar className="w-3 h-3" />
              Schedule
            </button>
            <button
              onClick={handleView}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-border/40 border border-border text-text-secondary text-xs font-medium hover:text-text-primary hover:border-text-secondary transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              View
            </button>
            <button
              onClick={handleDismiss}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-border/40 border border-border text-text-secondary text-xs font-medium hover:text-text-primary hover:border-text-secondary transition-colors"
            >
              <X className="w-3 h-3" />
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
