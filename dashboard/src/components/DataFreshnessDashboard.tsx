import React, { useState, useEffect } from 'react'
import { RefreshCw, Circle } from 'lucide-react'
import { formatRelTime } from '../lib/format'

// ── GitHub Issue #309: Registry-driven Data Freshness Dashboard ────────────

interface DataSourceStatus {
  name: string
  displayName: string
  lastChecked: string | null
  lastChanged: string | null
  recordCount: number | null
  intervalMinutes: number | null
  refreshEndpoint: string | null
  status: 'fresh' | 'stale' | 'critical' | 'unknown'
  state: 'idle' | 'refreshing' | 'queued' | 'error'
  error: string | null
}

interface FreshnessResponse {
  sources: DataSourceStatus[]
}

export function DataFreshnessDashboard() {
  const [sources, setSources] = useState<DataSourceStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshingSource, setRefreshingSource] = useState<string | null>(null)

  const loadFreshness = async () => {
    try {
      const res = await fetch('/api/status/freshness')
      if (!res.ok) throw new Error('Failed to load freshness data')
      const data: FreshnessResponse = await res.json()
      setSources(data.sources)
    } catch (err) {
      console.error('Failed to load data freshness:', err)
    }
  }

  useEffect(() => {
    setLoading(true)
    loadFreshness().finally(() => setLoading(false))

    // Auto-refresh every 30 seconds
    const interval = setInterval(() => {
      loadFreshness()
    }, 30000)

    return () => clearInterval(interval)
  }, [])

  const handleRefreshSource = async (source: DataSourceStatus) => {
    if (!source.refreshEndpoint) return

    setRefreshingSource(source.name)
    try {
      const fetchOpts: RequestInit = { method: 'POST' }
      if (source.name === 'news') {
        fetchOpts.headers = { 'Content-Type': 'application/json' }
        fetchOpts.body = JSON.stringify({ action: 'news-refresh' })
      }
      const res = await fetch(source.refreshEndpoint, fetchOpts)
      if (!res.ok) throw new Error('Refresh failed')

      // Reload freshness status after a short delay
      setTimeout(() => {
        loadFreshness()
      }, 1000)
    } catch (err) {
      console.error(`Failed to refresh ${source.name}:`, err)
    } finally {
      setRefreshingSource(null)
    }
  }

  const handleRefreshAll = async () => {
    setRefreshingAll(true)
    try {
      // Trigger all available refresh endpoints in parallel
      const refreshSources = sources.filter(s => s.refreshEndpoint)
      await Promise.allSettled(
        refreshSources.map(s => {
          const opts: RequestInit = { method: 'POST' }
          if (s.name === 'news') {
            opts.headers = { 'Content-Type': 'application/json' }
            opts.body = JSON.stringify({ action: 'news-refresh' })
          }
          return fetch(s.refreshEndpoint!, opts)
        })
      )

      // Reload freshness status after a short delay
      setTimeout(() => {
        loadFreshness()
      }, 2000)
    } catch (err) {
      console.error('Failed to refresh all:', err)
    } finally {
      setRefreshingAll(false)
    }
  }

  // Calculate overall health
  const freshCount = sources.filter(s => s.status === 'fresh').length
  const staleCount = sources.filter(s => s.status === 'stale').length
  const criticalCount = sources.filter(s => s.status === 'critical').length

  if (loading && sources.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 animate-spin text-text-secondary" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Summary Bar */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-text-secondary">
          {freshCount}/{sources.length} sources fresh
          {criticalCount > 0 && (
            <span className="ml-2 text-red-400">&#x2022; {criticalCount} critical</span>
          )}
          {staleCount > 0 && criticalCount === 0 && (
            <span className="ml-2 text-yellow-400">&#x2022; {staleCount} stale</span>
          )}
        </div>
        <button
          onClick={handleRefreshAll}
          disabled={refreshingAll}
          className="px-4 py-2 bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${refreshingAll ? 'animate-spin' : ''}`} />
          Refresh All
        </button>
      </div>

      {/* Source Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sources.map(source => (
          <div
            key={source.name}
            data-source={source.name}
            className="bg-bg border border-border rounded-xl p-4 hover:border-border-hover transition-colors"
          >
            {/* Header */}
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <Circle
                  data-testid="status-indicator"
                  className={`w-3 h-3 fill-current ${
                    source.status === 'fresh'
                      ? 'text-green-400'
                      : source.status === 'stale'
                      ? 'text-yellow-400'
                      : source.status === 'critical'
                      ? 'text-red-400'
                      : 'text-gray-400'
                  }`}
                />
                <h3 className="text-sm font-semibold text-white">
                  {source.displayName}
                </h3>
              </div>

              {source.refreshEndpoint && (
                <button
                  onClick={() => handleRefreshSource(source)}
                  disabled={refreshingSource === source.name || source.state === 'refreshing'}
                  className="text-xs text-text-secondary hover:text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
                >
                  <RefreshCw
                    className={`w-3 h-3 ${refreshingSource === source.name || source.state === 'refreshing' ? 'animate-spin' : ''}`}
                  />
                  Refresh
                </button>
              )}
            </div>

            {/* Details */}
            <div className="space-y-1 text-xs">
              {source.lastChecked ? (
                <div className="text-text-secondary">
                  Checked: <span className="text-text-primary">{formatRelTime(source.lastChecked)}</span>
                </div>
              ) : (
                <div className="text-text-secondary">No data yet</div>
              )}

              {source.lastChanged && source.lastChanged !== source.lastChecked && (
                <div className="text-text-secondary">
                  Updated: <span className="text-text-primary">{formatRelTime(source.lastChanged)}</span>
                </div>
              )}

              {source.lastChecked && !source.lastChanged && (
                <div className="text-text-secondary italic">No data yet</div>
              )}

              {source.recordCount !== null && (
                <div className="text-text-secondary">
                  Records: <span className="text-text-primary">{source.recordCount.toLocaleString()}</span>
                </div>
              )}

              {source.intervalMinutes !== null && (
                <div className="text-text-secondary">
                  Interval: <span className="text-text-primary">
                    {source.intervalMinutes < 60
                      ? `${source.intervalMinutes}m`
                      : source.intervalMinutes < 1440
                      ? `${Math.floor(source.intervalMinutes / 60)}h`
                      : `${Math.floor(source.intervalMinutes / 1440)}d`}
                  </span>
                </div>
              )}

              {source.error && (
                <div className="text-red-400 mt-1">
                  {source.error}
                </div>
              )}

              {!source.refreshEndpoint && source.intervalMinutes && (
                <div className="text-xs text-text-secondary italic mt-2">
                  Scheduler only
                </div>
              )}

              {!source.refreshEndpoint && !source.intervalMinutes && (
                <div className="text-xs text-text-secondary italic mt-2">
                  Manual only
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
