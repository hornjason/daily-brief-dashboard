interface HealthDotProps {
  score: number
  size?: 'sm' | 'md'
  showScore?: boolean
}

export default function HealthDot({ score, size = 'sm', showScore = false }: HealthDotProps) {
  const color = score >= 70 ? 'bg-health-green' : score >= 40 ? 'bg-health-amber' : 'bg-health-red'
  const textColor = score >= 70 ? 'text-health-green' : score >= 40 ? 'text-health-amber' : 'text-health-red'
  const sizeClass = size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3'
  const label = score >= 70 ? 'Healthy' : score >= 40 ? 'Attention' : 'Critical'

  return (
    <span className="inline-flex items-center gap-1.5" title={`Health: ${score}/100 — ${label}`}>
      <span className={`inline-block ${sizeClass} rounded-full ${color}`} />
      {showScore && <span className={`text-xs tabular-nums ${textColor}`}>{score}</span>}
    </span>
  )
}
