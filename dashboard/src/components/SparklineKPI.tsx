interface SparklineKPIProps {
  data: number[]
  width?: number
  height?: number
  color?: string
}

export default function SparklineKPI({
  data,
  width = 80,
  height = 24,
  color = '#00BCD4',
}: SparklineKPIProps) {
  if (!data || data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const padding = 2
  const plotW = width - padding * 2
  const plotH = height - padding * 2

  const points = data
    .map((v, i) => {
      const x = padding + (i / (data.length - 1)) * plotW
      const y = padding + plotH - ((v - min) / range) * plotH
      return `${x},${y}`
    })
    .join(' ')

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
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
