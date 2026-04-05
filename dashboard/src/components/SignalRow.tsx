import SignalPriorityBadge from './SignalPriorityBadge'
import SignalActionChip from './SignalActionChip'
import type { SignalPriority } from './SignalPriorityBadge'
import type { ChipVariant } from './SignalActionChip'

export interface SignalRowProps {
  priority: SignalPriority
  text: string
  chip?: { label: string; href: string; variant: ChipVariant }
}

export default function SignalRow({ priority, text, chip }: SignalRowProps) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <SignalPriorityBadge priority={priority} />
      <span className="text-sm text-text-primary flex-1 min-w-0 truncate">{text}</span>
      {chip && (
        <SignalActionChip label={chip.label} href={chip.href} variant={chip.variant} />
      )}
    </div>
  )
}
