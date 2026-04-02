import { Zap } from 'lucide-react'

interface PriorityAction {
  text: string
  severity: 'critical' | 'high' | 'medium'
  source: string
}

interface PriorityActionBannerProps {
  action: PriorityAction | null
}

export default function PriorityActionBanner({ action }: PriorityActionBannerProps) {
  if (!action) return null

  const borderColor =
    action.severity === 'critical' ? 'border-l-health-red'
    : action.severity === 'high' ? 'border-l-health-amber'
    : 'border-l-accent'

  return (
    <div className={`bg-surface border border-border rounded-xl border-l-[3px] ${borderColor} p-4 flex items-start gap-3`}>
      <Zap className="w-4 h-4 text-accent shrink-0 mt-0.5" />
      <div>
        <p className="text-sm font-medium text-text-primary">{action.text}</p>
        <p className="text-xs text-text-secondary mt-1">Source: {action.source}</p>
      </div>
    </div>
  )
}
