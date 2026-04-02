interface RelTimeProps {
  iso: string
  className?: string
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  })
}

export default function RelTime({ iso, className = '' }: RelTimeProps) {
  if (!iso) return null
  return (
    <time dateTime={iso} title={formatAbsolute(iso)} className={`${className}`}>
      {formatRelative(iso)}
    </time>
  )
}
