import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Circle } from 'lucide-react'
import { formatRelTime } from '../../lib/format'

// ── Types ──────────────────────────────────────────────────────────────────────

const FRIENDLY_NAMES: Record<string, string> = {
  'news-radar': 'Customer News',
  'product-lifecycle': 'Product End-of-Life Dates',
  'rh-rss': 'Red Hat Blog & Press',
  'rh-events': 'Red Hat Events',
  'product-intel': 'Product Features & Releases',
  'ccsp': 'Cloud Spend (CCSP)',
  'value-maps': 'Business Value Maps',
  'cases': 'Support Cases',
  'subscriptions': 'Subscriptions',
  'pipeline': 'Sales Pipeline',
  'customer-docs': 'Customer Drive Documents',
  'customer-product-intel': 'Product Talking Points',
  'emails': 'Email History',
  'intelligence': 'Company Intelligence',
  'account-plan': 'Account Plans',
  'cloud-marketplace': 'Cloud Marketplace Programs',
  'tech-stack': 'Technology Detection',
  'playbook': 'Engagement Playbook',
}

interface DataSourceStatus {
  name: string
  displayName: string
  lastChecked: string | null
  recordCount: number | null
  status: 'fresh' | 'stale' | 'critical' | 'unknown'
  state: 'idle' | 'refreshing' | 'queued' | 'error'
  error: string | null
  refreshEndpoint: string | null
}

// ── Data Source Card ───────────────────────────────────────────────────────────

function DataSourceCard({
  source,
  onRefresh,
  refreshing,
}: {
  source: DataSourceStatus
  onRefresh: () => void
  refreshing: boolean
}) {
  const statusColor =
    source.status === 'fresh'
      ? 'text-green-400'
      : source.status === 'stale'
        ? 'text-yellow-400'
        : source.status === 'critical'
          ? 'text-red-400'
          : 'text-gray-400'

  const stateColor =
    source.state === 'refreshing'
      ? 'text-yellow-400'
      : source.state === 'error'
        ? 'text-red-400'
        : 'text-green-400'

  const displayName = source.displayName || FRIENDLY_NAMES[source.name] || source.name

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Circle className={`w-3 h-3 fill-current ${statusColor}`} />
          <span className="text-sm font-medium text-gray-200">{displayName}</span>
        </div>
        {source.refreshEndpoint && (
          <button
            onClick={onRefresh}
            disabled={refreshing || source.state === 'refreshing'}
            aria-label={`Refresh ${displayName}`}
            className="px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${refreshing || source.state === 'refreshing' ? 'animate-spin' : ''}`}
            />
            <span>Refresh</span>
          </button>
        )}
      </div>
      <div className="space-y-1 text-xs text-gray-400">
        {source.lastChecked && (
          <div>
            Last checked: <span className="text-gray-300">{formatRelTime(source.lastChecked)}</span>
          </div>
        )}
        {!source.lastChecked && <div className="text-gray-500">Never run</div>}
        {source.recordCount !== null && (
          <div>
            Records: <span className="text-gray-300">{source.recordCount.toLocaleString()}</span>
          </div>
        )}
        {source.state === 'refreshing' && (
          <div className="flex items-center gap-1.5 text-yellow-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
            Refreshing...
          </div>
        )}
        {source.error && source.state === 'error' && (
          <div className="text-red-400 truncate" title={source.error}>
            Error: {source.error}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Panel ─────────────────────────────────────────────────────────────────

export function DataSourcesPanel() {
  const [sources, setSources] = useState<DataSourceStatus[]>([])
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})

  const loadData = useCallback(async () => {
    try {
      const freshRes = await fetch('/api/status/freshness')
      if (freshRes.ok) {
        const freshData = await freshRes.json()
        setSources(freshData.sources ?? [])
      }
    } catch (err) {
      console.error('Failed to load data sources:', err)
    }
  }, [])

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 30000)
    return () => clearInterval(interval)
  }, [loadData])

  const handleRefreshSource = async (source: DataSourceStatus) => {
    if (!source.refreshEndpoint) return

    setRefreshing((r) => ({ ...r, [source.name]: true }))
    try {
      const res = await fetch(source.refreshEndpoint, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error(`Refresh failed for ${source.name}:`, (data as { error?: string }).error)
      }
      await loadData()
    } catch (err) {
      console.error(`Network error refreshing ${source.name}:`, err)
    } finally {
      setRefreshing((r) => ({ ...r, [source.name]: false }))
    }
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-200 mb-3">Data Sources</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sources.map((source) => (
          <DataSourceCard
            key={source.name}
            source={source}
            onRefresh={() => handleRefreshSource(source)}
            refreshing={refreshing[source.name] ?? false}
          />
        ))}
      </div>
    </div>
  )
}
