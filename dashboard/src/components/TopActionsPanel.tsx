import { Zap } from 'lucide-react'
import SignalActionChip from './SignalActionChip'
import SignalPriorityBadge from './SignalPriorityBadge'
import type { SignalPriority } from './SignalPriorityBadge'
import type { ChipVariant } from './SignalActionChip'

export interface TopAction {
  customerName: string
  signal: string
  chips: Array<{ label: string; href: string; variant: ChipVariant }>
  priority: SignalPriority
}

export interface TopActionsPanelProps {
  actions: TopAction[]
}

export default function TopActionsPanel({ actions }: TopActionsPanelProps) {
  if (actions.length === 0) return null

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3 flex items-center gap-2 border-b border-border">
        <Zap className="w-4 h-4 text-accent" />
        <h3 className="text-base font-semibold text-text-primary">Top Actions</h3>
      </div>
      <div className="p-4 space-y-2.5">
        {actions.slice(0, 3).map((action, i) => (
          <div
            key={i}
            className="flex items-start gap-3 rounded-lg px-2 py-2 -mx-2 hover:bg-border/20 transition-colors"
          >
            <span className="text-xs font-bold text-text-secondary mt-0.5 w-4 text-center shrink-0">
              {i + 1}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-text-primary">{action.customerName}</span>
                <SignalPriorityBadge priority={action.priority} />
              </div>
              <p className="text-sm text-text-secondary mt-0.5 leading-snug">{action.signal}</p>
              {action.chips.length > 0 && (
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  {action.chips.map((chip, j) => (
                    <SignalActionChip key={j} label={chip.label} href={chip.href} variant={chip.variant} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
