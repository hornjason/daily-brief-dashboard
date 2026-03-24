import { RefreshCw } from 'lucide-react'

interface TopBarProps {
  lastSynced: string | null
  loading: boolean
  onRefresh: () => void
}

export function TopBar({ lastSynced, loading, onRefresh }: TopBarProps) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return (
    <header className="h-14 bg-surface border-b border-border px-6 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-text-primary">Command Center</h1>
        <span className="text-sm text-text-secondary">{today}</span>
      </div>
      <div className="flex items-center gap-4">
        {lastSynced && (
          <span className="text-xs text-text-secondary">Last synced: {lastSynced}</span>
        )}
        <button
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-text-secondary text-sm hover:border-text-secondary hover:text-text-primary disabled:opacity-40 transition-all"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
    </header>
  )
}
