// dashboard/src/lib/signal-aging.ts
// GitHub Issue #281 — Visual signal aging utilities

/**
 * Format an ISO timestamp as relative time.
 * Returns human-readable strings like "2h ago", "3d ago", "2w ago".
 */
export function formatRelativeTime(timestamp: string): string {
  const now = Date.now()
  const then = new Date(timestamp).getTime()
  const deltaMs = now - then

  if (deltaMs < 0) return 'future' // Shouldn't happen for signals

  const seconds = Math.floor(deltaMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const weeks = Math.floor(days / 7)
  const months = Math.floor(days / 30)

  if (seconds < 60) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  if (weeks < 4) return `${weeks}w ago`
  if (months < 12) return `${months}mo ago`

  const years = Math.floor(months / 12)
  return `${years}y ago`
}

/**
 * Calculate visual opacity for a signal based on age.
 * Fresh signals (< 7 days) = full opacity (1.0)
 * Signals fade continuously from 7 days to 30+ days (opacity: 1.0 → 0.5)
 *
 * Uses a continuous decay curve, not a binary cutoff.
 */
export function signalOpacity(timestamp: string): number {
  const now = Date.now()
  const then = new Date(timestamp).getTime()
  const ageMs = now - then

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

  // Fresh signals (< 7 days) → full opacity
  if (ageMs < SEVEN_DAYS_MS) return 1.0

  // Stale signals (>= 30 days) → minimum opacity
  if (ageMs >= THIRTY_DAYS_MS) return 0.5

  // Continuous decay from 7 to 30 days
  // Linear interpolation: opacity = 1.0 - ((age - 7d) / (30d - 7d)) * 0.5
  const decayRange = THIRTY_DAYS_MS - SEVEN_DAYS_MS
  const decayProgress = (ageMs - SEVEN_DAYS_MS) / decayRange
  return 1.0 - (decayProgress * 0.5)
}
