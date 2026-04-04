interface DataQualityBadgeProps {
  cachedAt: string | null
}

export function DataQualityBadge({ cachedAt }: DataQualityBadgeProps) {
  if (!cachedAt) return <span className="text-xs text-gray-400 px-2 py-0.5 rounded-full bg-gray-100">No brief</span>
  const ageMs = Date.now() - new Date(cachedAt).getTime()
  const ageH = ageMs / 3_600_000
  if (ageH < 1) return <span className="text-xs text-green-700 px-2 py-0.5 rounded-full bg-green-100">Fresh</span>
  if (ageH < 4) return <span className="text-xs text-amber-700 px-2 py-0.5 rounded-full bg-amber-100">{Math.round(ageH)}h ago</span>
  return <span className="text-xs text-red-700 px-2 py-0.5 rounded-full bg-red-100">{Math.round(ageH)}h ago</span>
}
