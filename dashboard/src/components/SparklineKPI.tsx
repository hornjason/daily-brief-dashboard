// Sparkline colors per VISUAL-DESIGN-SPEC.md
const SPARK_UP = '#3FB950'    // spark-up (green — improving)
const SPARK_DOWN = '#F85149'  // spark-down (red — worsening)
const SPARK_NEUTRAL = '#484F58' // spark-neutral (flat)

/**
 * Compute trend direction from last N data points using simple linear slope.
 * Returns 'up' | 'down' | 'neutral'.
 */
function computeTrend(data: number[], windowSize = 5): 'up' | 'down' | 'neutral' {
  const window = data.slice(-Math.min(windowSize, data.length))
  if (window.length < 2) return 'neutral'
  // Simple least-squares slope
  const n = window.length
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0
  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += window[i]
    sumXY += i * window[i]
    sumX2 += i * i
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
  // Normalize slope relative to value range to determine significance
  const range = Math.max(...window) - Math.min(...window)
  if (range === 0) return 'neutral'
  const normalizedSlope = slope / range
  if (normalizedSlope > 0.05) return 'up'
  if (normalizedSlope < -0.05) return 'down'
  return 'neutral'
}

interface SparklineKPIProps {
  data: number[]
  width?: number
  height?: number
  color?: string
  /** When true, higher values are "bad" (e.g., open cases) — inverts trend color */
  invertTrend?: boolean
}

export default function SparklineKPI({
  data,
  width = 80,
  height = 24,
  color,
  invertTrend = false,
}: SparklineKPIProps) {
  const safe = (data ?? []).filter(Number.isFinite)
  if (safe.length < 2) return null

  const min = Math.min(...safe)
  const max = Math.max(...safe)
  const range = max - min || 1

  const padding = 2
  const plotW = width - padding * 2
  const plotH = height - padding * 2

  const points = safe
    .map((v, i) => {
      const x = padding + (i / (safe.length - 1)) * plotW
      const y = padding + plotH - ((v - min) / range) * plotH
      return `${x},${y}`
    })
    .join(' ')

  // Compute trend-direction color per VISUAL-DESIGN-SPEC.md
  const trend = computeTrend(safe)
  const trendColor = trend === 'neutral'
    ? SPARK_NEUTRAL
    : trend === 'up'
      ? (invertTrend ? SPARK_DOWN : SPARK_UP)
      : (invertTrend ? SPARK_UP : SPARK_DOWN)

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="inline-block"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={trendColor}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
