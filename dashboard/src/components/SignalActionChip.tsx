import type { ReactNode } from 'react'

export type ChipVariant = 'calendar' | 'case' | 'salesforce' | 'email'

export interface SignalActionChipProps {
  label: string
  href: string
  variant: ChipVariant
}

const variantStyles: Record<ChipVariant, string> = {
  calendar: 'border-cyan-500/40 text-[#00BCD4] bg-cyan-500/10 hover:bg-cyan-500/20',
  case: 'border-red-400/40 text-red-400 bg-red-400/10 hover:bg-red-400/20',
  salesforce: 'border-blue-400/40 text-blue-400 bg-blue-400/10 hover:bg-blue-400/20',
  email: 'border-border text-text-secondary bg-border/20 hover:bg-border/40',
}

export default function SignalActionChip({ label, href, variant }: SignalActionChipProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center text-xs rounded-full px-2 py-0.5 border font-medium transition-colors ${variantStyles[variant]}`}
    >
      {label}
    </a>
  )
}
