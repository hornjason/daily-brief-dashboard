import type { ReactNode } from 'react'

interface StatBadgeProps {
  icon: ReactNode
  value: ReactNode
  label: string
  color?: string
  loading?: boolean
}

export function StatBadge({ icon, value, label, loading }: StatBadgeProps) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-hover rounded-lg">
      {icon}
      {loading ? (
        <span className="inline-block h-4 w-6 bg-border/40 rounded animate-pulse" />
      ) : (
        <span className="text-xs font-semibold text-text-primary tabular-nums">{value}</span>
      )}
      <span className="text-xs text-text-secondary">{label}</span>
    </div>
  )
}

export default StatBadge
