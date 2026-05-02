/**
 * InlineSparkline — tiny trend line for compact rows and header badges.
 *
 * Extracted from CustomerDetailPage (BKL-G05) for reuse in CCSP/Pipeline
 * compact rows and AE group headers (BKL-UX109).
 *
 * Props:
 *   values  — numeric series (min length 2 to render)
 *   width   — px width (default 32)
 *   height  — px height (default 12)
 *   color   — optional stroke color; when omitted, trend is auto-colored
 *             green (up/flat) or red (down) from first→last value.
 */

interface InlineSparklineProps {
  values: number[]
  width?: number
  height?: number
  color?: string
}

export default function InlineSparkline({
  values,
  width = 32,
  height = 12,
  color,
}: InlineSparklineProps) {
  const safe = values.filter(Number.isFinite)
  if (safe.length < 2) return null
  const w = width
  const h = height
  const max = Math.max(...safe, 1)
  const min = Math.min(...safe, 0)
  const range = max - min || 1
  const points = safe
    .map((v, i) => {
      const x = (i / (safe.length - 1)) * w
      const y = h - ((v - min) / range) * (h - 2) - 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  // Trend coloring (auto): up/flat = green, down = red
  const stroke = color ?? (safe[safe.length - 1] >= safe[0] ? '#3FB950' : '#F85149')

  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
