import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Circle, ChevronDown, ChevronRight } from 'lucide-react'
import { formatRelTime } from '../../lib/format'

// ── Friendly names ──────────────────────────────────────────────────────────

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
  'campaigns': 'Email Campaigns',
  'meeting-prep': 'Meeting Prep',
  'tools': 'Business Value Tools',
}

/** Fallback formatter: converts kebab-case to Title Case when no friendly name is defined. */
function formatSourceName(name: string): string {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// ── Source grouping ─────────────────────────────────────────────────────────

interface SourceGroup {
  label: string
  description: string
  sources: string[]
}

const SOURCE_GROUPS: SourceGroup[] = [
  {
    label: 'Customer Data',
    description: 'Raw data from CRM, support, and communication systems',
    sources: ['cases', 'emails', 'subscriptions', 'pipeline', 'ccsp'],
  },
  {
    label: 'Intelligence & Analysis',
    description: 'AI-generated insights and research about your customers',
    sources: ['intelligence', 'account-plan', 'news-radar', 'customer-product-intel'],
  },
  {
    label: 'Product & Market',
    description: 'Red Hat product updates, events, and market data',
    sources: ['product-lifecycle', 'product-intel', 'cloud-marketplace', 'tech-stack', 'value-maps', 'rh-rss', 'rh-events'],
  },
  {
    label: 'Generated Content',
    description: 'Documents and deliverables produced from your data',
    sources: ['playbook', 'campaigns', 'meeting-prep', 'customer-docs', 'tools'],
  },
]

// ── Types ───────────────────────────────────────────────────────────────────

interface DataSourceStatus {
  name: string
  displayName: string
  sourceDescription: string | null
  lastChecked: string | null
  recordCount: number | null
  status: 'fresh' | 'stale' | 'critical' | 'unknown'
  state: 'idle' | 'refreshing' | 'queued' | 'error'
  error: string | null
  refreshEndpoint: string | null
}

// ── Data Source Card ────────────────────────────────────────────────────────

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

  const displayName = source.displayName || FRIENDLY_NAMES[source.name] || formatSourceName(source.name)

  return (
    <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Circle className={`w-2.5 h-2.5 fill-current ${statusColor}`} />
          <div>
            <span className="text-sm font-medium text-gray-200">{displayName}</span>
            {source.sourceDescription && (
              <div className="text-xs text-gray-500">{source.sourceDescription}</div>
            )}
          </div>
        </div>
        {source.refreshEndpoint && (
          <button
            onClick={onRefresh}
            disabled={refreshing || source.state === 'refreshing'}
            aria-label={`Refresh ${displayName}`}
            className="px-2 py-1 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors whitespace-nowrap shrink-0 flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${refreshing || source.state === 'refreshing' ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        )}
      </div>
      <div className="space-y-0.5 text-xs text-gray-400">
        {source.lastChecked && (
          <div>Last checked: <span className="text-gray-300">{formatRelTime(source.lastChecked)}</span></div>
        )}
        {!source.lastChecked && <div className="text-gray-500">Never run</div>}
        {source.recordCount !== null && (
          <div>Records: <span className="text-gray-300">{source.recordCount.toLocaleString()}</span></div>
        )}
        {source.state === 'refreshing' && (
          <div className="flex items-center gap-1.5 text-yellow-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
            Refreshing...
          </div>
        )}
        {source.error && source.state === 'error' && (
          <div className="text-red-400 truncate" title={source.error}>Error: {source.error}</div>
        )}
      </div>
    </div>
  )
}

// ── Collapsible Group ───────────────────────────────────────────────────────

function SourceGroupSection({
  group,
  sources,
  onRefresh,
  refreshing,
}: {
  group: SourceGroup
  sources: DataSourceStatus[]
  onRefresh: (source: DataSourceStatus) => void
  refreshing: Record<string, boolean>
}) {
  const [open, setOpen] = useState(true)
  const groupSources = sources.filter(s => group.sources.includes(s.name))
  if (groupSources.length === 0) return null

  const freshCount = groupSources.filter(s => s.status === 'fresh').length

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-800 hover:bg-gray-750 transition-colors text-left"
        aria-label={`${open ? 'Collapse' : 'Expand'} ${group.label} section`}
      >
        <div>
          <span className="text-sm font-medium text-gray-200">{group.label}</span>
          <span className="ml-2 text-xs text-gray-500">{freshCount}/{groupSources.length} fresh</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">{group.description}</span>
          {open ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
        </div>
      </button>
      {open && (
        <div className="p-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {groupSources.map(source => (
            <DataSourceCard
              key={source.name}
              source={source}
              onRefresh={() => onRefresh(source)}
              refreshing={refreshing[source.name] ?? false}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main Panel ──────────────────────────────────────────────────────────────

export function DataSourcesPanel() {
  const [sources, setSources] = useState<DataSourceStatus[]>([])
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})
  const [refreshAllInProgress, setRefreshAllInProgress] = useState(false)
  const [refreshAllProgress, setRefreshAllProgress] = useState<{ completed: number; total: number } | null>(null)

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

  // Poll refresh-all status while in progress
  useEffect(() => {
    if (!refreshAllInProgress) return
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/admin/refresh-all/status')
        if (!res.ok) return
        const manifest = await res.json()
        const done = manifest.completed + manifest.failed + manifest.skipped
        setRefreshAllProgress({ completed: done, total: manifest.totalModules })
        if (manifest.inProgress === null && manifest.totalModules > 0 && done >= manifest.totalModules) {
          setRefreshAllInProgress(false)
          setRefreshAllProgress(null)
          loadData()
        }
      } catch {
        // Polling failure is non-fatal
      }
    }, 3000)
    return () => clearInterval(poll)
  }, [refreshAllInProgress, loadData])

  const handleRefreshAll = async () => {
    setRefreshAllInProgress(true)
    setRefreshAllProgress({ completed: 0, total: 0 })
    try {
      const res = await fetch('/api/admin/refresh-all', { method: 'POST' })
      if (!res.ok) {
        console.error('Refresh All failed:', await res.text())
        setRefreshAllInProgress(false)
        setRefreshAllProgress(null)
      }
    } catch (err) {
      console.error('Network error starting Refresh All:', err)
      setRefreshAllInProgress(false)
      setRefreshAllProgress(null)
    }
  }

  const handleRefreshSource = async (source: DataSourceStatus) => {
    if (!source.refreshEndpoint) return
    setRefreshing(r => ({ ...r, [source.name]: true }))
    try {
      const res = await fetch(source.refreshEndpoint, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error(`Refresh failed for ${source.name}:`, (data as { error?: string }).error)
      }
      // Poll until done for async endpoints
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000))
        await loadData()
        const current = sources.find(s => s.name === source.name)
        if (current && current.state !== 'refreshing') break
      }
    } catch (err) {
      console.error(`Network error refreshing ${source.name}:`, err)
    } finally {
      setRefreshing(r => ({ ...r, [source.name]: false }))
    }
  }

  return (
    <div className="space-y-3">
      {/* Refresh All button */}
      <div className="flex items-center justify-between">
        <button
          onClick={handleRefreshAll}
          disabled={refreshAllInProgress}
          className="px-3 py-1.5 text-sm font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${refreshAllInProgress ? 'animate-spin' : ''}`} />
          {refreshAllInProgress
            ? (refreshAllProgress && refreshAllProgress.total > 0
              ? `Refreshing... ${refreshAllProgress.completed}/${refreshAllProgress.total} modules`
              : 'Refresh in progress...')
            : 'Refresh All'}
        </button>
      </div>

      {SOURCE_GROUPS.map(group => (
        <SourceGroupSection
          key={group.label}
          group={group}
          sources={sources}
          onRefresh={handleRefreshSource}
          refreshing={refreshing}
        />
      ))}
    </div>
  )
}
