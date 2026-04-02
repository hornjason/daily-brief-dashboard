interface BriefAgePillProps {
  generatedAt: string | null | undefined
}

export default function BriefAgePill({ generatedAt }: BriefAgePillProps) {
  if (!generatedAt) return null

  const ageMs = Date.now() - new Date(generatedAt).getTime()
  const ageHours = ageMs / (1000 * 60 * 60)

  let color: string
  let label: string

  if (ageHours < 24) {
    color = 'bg-health-green-bg text-health-green border-health-green-border'
    label = ageHours < 1 ? 'Just generated' : `${Math.floor(ageHours)}h ago`
  } else if (ageHours < 72) {
    const days = Math.floor(ageHours / 24)
    color = 'bg-health-amber-bg text-health-amber border-health-amber-border'
    label = `${days}d ago`
  } else {
    const days = Math.floor(ageHours / 24)
    color = 'bg-health-red-bg text-health-red border-health-red-border'
    label = `${days}d ago`
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border rounded-pill ${color}`}>
      {label}
    </span>
  )
}
