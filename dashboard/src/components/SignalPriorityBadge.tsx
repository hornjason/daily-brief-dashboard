export type SignalPriority = 'urgent' | 'this-week' | 'fyi'

export interface SignalPriorityBadgeProps {
  priority: SignalPriority
}

const dotColor: Record<SignalPriority, string> = {
  urgent: 'bg-red-400',
  'this-week': 'bg-amber-400',
  fyi: 'bg-text-secondary',
}

const labelText: Record<SignalPriority, string> = {
  urgent: 'Urgent',
  'this-week': 'This week',
  fyi: 'FYI',
}

const textColor: Record<SignalPriority, string> = {
  urgent: 'text-red-400',
  'this-week': 'text-amber-400',
  fyi: 'text-text-secondary',
}

export default function SignalPriorityBadge({ priority }: SignalPriorityBadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${textColor[priority]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor[priority]}`} />
      {labelText[priority]}
    </span>
  )
}
