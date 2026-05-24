// dashboard/src/components/SignalWithAging.tsx
// GitHub Issue #281 — Wrapper component for signal display with visual aging

import { formatRelativeTime, signalOpacity } from '../lib/signal-aging'

interface SignalWithAgingProps {
  timestamp: string
  children: React.ReactNode
  className?: string
  /** If true, shows timestamp as inline text. If false, only applies opacity. */
  showTimestamp?: boolean
}

/**
 * Wrapper component that applies visual aging to signals:
 * - Opacity decay for signals older than 7 days
 * - Optional relative timestamp display
 * - Continuous decay curve (no binary cutoffs)
 */
export default function SignalWithAging({
  timestamp,
  children,
  className = '',
  showTimestamp = true
}: SignalWithAgingProps) {
  const opacity = signalOpacity(timestamp)
  const relativeTime = formatRelativeTime(timestamp)

  return (
    <div
      className={className}
      style={{ opacity }}
      title={`Last updated: ${new Date(timestamp).toLocaleString()} (${relativeTime})`}
    >
      {children}
      {showTimestamp && (
        <div className="text-xs text-text-secondary/70 mt-1">
          {relativeTime}
        </div>
      )}
    </div>
  )
}
