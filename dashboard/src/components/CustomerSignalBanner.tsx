import { Star } from 'lucide-react'
import SignalActionChip from './SignalActionChip'
import type { ChipVariant } from './SignalActionChip'

export interface SignalChip {
  label: string
  href: string
  variant: ChipVariant
}

export interface CustomerSignalBannerProps {
  signal: string
  chips: SignalChip[]
  priority?: 'urgent' | 'this-week'
}

export default function CustomerSignalBanner({ signal, chips, priority = 'urgent' }: CustomerSignalBannerProps) {
  const borderAccent = priority === 'urgent' ? 'border-l-amber-400' : 'border-l-[#00BCD4]'

  return (
    <div className={`bg-border/20 rounded-lg p-3 border-l-[3px] ${borderAccent}`}>
      <div className="flex items-start gap-2.5">
        <Star className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary leading-snug">{signal}</p>
          {chips.length > 0 && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {chips.slice(0, 3).map((chip, i) => (
                <SignalActionChip key={i} label={chip.label} href={chip.href} variant={chip.variant} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
