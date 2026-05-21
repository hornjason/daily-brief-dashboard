import { useState, useEffect, useCallback } from 'react'
import { Circle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { formatRelTime } from '../../lib/format'

// ── Types ──────────────────────────────────────────────────────────────────────

interface ScraperStatus {
  name: string
  state: 'idle' | 'running' | 'error'
  lastSuccess: string | null
  lastError: string | null
}

interface ScrapeLogEntry {
  timestamp: string
  service: string
  durationMs: number
  recordCount: number
  status: 'success' | 'failure' | 'skipped' | 'timeout'
  error?: string
}

interface GeminiUsage {
  todayInputTokens: number
  todayOutputTokens: number
  todayCostUsd: number
  monthInputTokens: number
  monthOutputTokens: number
  monthCostUsd: number
  totalCalls: number
}

interface CacheCategory {
  count: number
  oldestAt: string | null
  newestAt: string | null
}

// ── Collapsible Section ────────────────────────────────────────────────────────

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-label={isOpen ? `Collapse ${title} section` : `Expand ${title} section`}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-700/50 transition-colors"
      >
        <span className="text-sm font-medium text-gray-200">{title}</span>
        {isOpen ? (
          <ChevronDown className="w-4 h-4 text-gray-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-400" />
        )}
      </button>
      {isOpen && <div className="px-4 pb-4 border-t border-gray-700">{children}</div>}
    </div>
  )
}

// ── Scraper Health Section ─────────────────────────────────────────────────────

function ScraperHealthSection() {
  const [scrapers, setScrapers] = useState<ScraperStatus[]>([])
  const [running, setRunning] = useState<Record<string, boolean>>({})

  const loadScrapers = useCallback(async () => {
    try {
      const res = await fetch('/api/scraper-status')
      if (res.ok) {
        const data = await res.json()
        const scraperList = Object.entries(data.scrapers ?? {}).map(([key, val]: [string, any]) => ({
          name: key,
          state: val.state,
          lastSuccess: val.lastSuccess,
          lastError: val.lastError,
        }))
        setScrapers(scraperList)
      }
    } catch (err) {
      console.error('Failed to load scraper status:', err)
    }
  }, [])

  useEffect(() => {
    loadScrapers()
    const interval = setInterval(loadScrapers, 10000)
    return () => clearInterval(interval)
  }, [loadScrapers])

  const handleRefresh = async (scraperName: string) => {
    setRunning((r) => ({ ...r, [scraperName]: true }))
    try {
      const endpointMap: Record<string, string> = {
        'rh-cases': '/api/scrape/rh',
        'ccsp': '/api/refresh/ccsp',
        'sf-pipeline': '/api/refresh/pipeline',
      }
      const endpoint = endpointMap[scraperName]
      if (!endpoint) {
        console.error(`No endpoint configured for scraper: ${scraperName}`)
        return
      }
      const res = await fetch(endpoint, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error(`Refresh failed for ${scraperName}:`, (data as { error?: string }).error)
        return
      }
      // Poll until the scraper finishes (some endpoints queue work and return immediately)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000))
        await loadScrapers()
        const current = scrapers.find(s => s.name === scraperName)
        if (current && current.state !== 'running') break
      }
    } catch (err) {
      console.error(`Network error refreshing ${scraperName}:`, err)
    } finally {
      setRunning((r) => ({ ...r, [scraperName]: false }))
    }
  }

  const SCRAPER_NAMES: Record<string, string> = {
    'rh-cases': 'Red Hat Support Cases',
    'ccsp': 'Cloud Spend (CCSP)',
    'sf-pipeline': 'Salesforce Pipeline',
  }

  const stateDot = (state: string) => {
    if (state === 'idle' || state === 'fresh') return 'text-green-400'
    if (state === 'running') return 'text-yellow-400 animate-pulse'
    if (state === 'stale') return 'text-yellow-400'
    return 'text-red-400'
  }

  return (
    <div className="mt-4 space-y-2">
      {scrapers.length === 0 ? (
        <div className="text-xs text-gray-500">No scrapers configured</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-700 text-gray-400">
              <th className="text-left py-2">Scraper</th>
              <th className="text-left py-2">State</th>
              <th className="text-left py-2">Last Success</th>
              <th className="text-left py-2">Last Error</th>
              <th className="text-right py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {scrapers.map((scraper) => (
              <tr key={scraper.name} className="border-b border-gray-700 text-gray-300">
                <td className="py-2">{SCRAPER_NAMES[scraper.name] ?? scraper.name}</td>
                <td className="py-2">
                  <div className="flex items-center gap-1.5">
                    <Circle className={`w-3 h-3 fill-current ${stateDot(scraper.state)}`} />
                    <span className={stateDot(scraper.state)}>{scraper.state}</span>
                  </div>
                </td>
                <td className="py-2">
                  {scraper.lastSuccess ? formatRelTime(scraper.lastSuccess) : '—'}
                </td>
                <td className="py-2 truncate max-w-[200px]" title={scraper.lastError ?? undefined}>
                  {scraper.lastError ?? '—'}
                </td>
                <td className="py-2 text-right">
                  <button
                    onClick={() => handleRefresh(scraper.name)}
                    disabled={running[scraper.name] || scraper.state === 'running'}
                    aria-label={`Refresh ${scraper.name}`}
                    className="px-2.5 py-1 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white transition-colors flex items-center gap-1.5 ml-auto"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${running[scraper.name] || scraper.state === 'running' ? 'animate-spin' : ''}`}
                    />
                    <span>Refresh</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Scrape History Section ─────────────────────────────────────────────────────

function ScrapeHistorySection() {
  const [history, setHistory] = useState<ScrapeLogEntry[]>([])

  useEffect(() => {
    const load = () =>
      fetch('/api/status/telemetry/history')
        .then((r) => r.json())
        .then((d: Record<string, ScrapeLogEntry[]>) => {
          const all = Object.values(d).flatMap((entries) =>
            [...entries]
              .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
              .slice(0, 10)
          )
          all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          setHistory(all.slice(0, 10))
        })
        .catch(() => {})
    load()
    const interval = setInterval(load, 10000)
    return () => clearInterval(interval)
  }, [])

  const STATUS_COLORS: Record<string, string> = {
    success: 'text-green-400',
    failure: 'text-red-400',
    skipped: 'text-yellow-400',
    timeout: 'text-orange-400',
  }

  return (
    <div className="mt-4">
      {history.length === 0 ? (
        <div className="text-xs text-gray-500">No scrape history</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-700 text-gray-400">
              <th className="text-left py-2">Time</th>
              <th className="text-left py-2">Scraper</th>
              <th className="text-left py-2">Status</th>
              <th className="text-right py-2">Records</th>
              <th className="text-right py-2">Duration</th>
            </tr>
          </thead>
          <tbody>
            {history.map((row, i) => (
              <tr key={i} className="border-b border-gray-700 text-gray-300">
                <td className="py-2">{formatRelTime(row.timestamp)}</td>
                <td className="py-2">{row.service}</td>
                <td className={`py-2 ${STATUS_COLORS[row.status] ?? 'text-gray-400'}`}>{row.status}</td>
                <td className="py-2 text-right">{row.recordCount}</td>
                <td className="py-2 text-right">
                  {row.durationMs >= 60000
                    ? `${Math.round(row.durationMs / 60000)}m`
                    : `${Math.round(row.durationMs / 1000)}s`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Gemini Usage Section ───────────────────────────────────────────────────────

function GeminiUsageSection() {
  const [usage, setUsage] = useState<GeminiUsage | null>(null)

  useEffect(() => {
    fetch('/api/admin/gemini-usage')
      .then((r) => r.json())
      .then((d) => setUsage(d))
      .catch(() => {})
  }, [])

  return (
    <div className="mt-4 space-y-2">
      {usage === null ? (
        <div className="text-xs text-gray-500">Loading...</div>
      ) : usage.totalCalls === 0 ? (
        <div className="text-xs text-gray-500">No Gemini calls recorded</div>
      ) : (
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div className="bg-gray-900/50 rounded p-3">
            <div className="text-gray-400 mb-1">Today</div>
            <div className="text-gray-200">
              {(usage.todayInputTokens + usage.todayOutputTokens).toLocaleString()} tokens
            </div>
            <div className="text-yellow-400 font-medium">${usage.todayCostUsd.toFixed(4)}</div>
          </div>
          <div className="bg-gray-900/50 rounded p-3">
            <div className="text-gray-400 mb-1">This Month</div>
            <div className="text-gray-200">
              {(usage.monthInputTokens + usage.monthOutputTokens).toLocaleString()} tokens
            </div>
            <div className="text-yellow-400 font-medium">${usage.monthCostUsd.toFixed(4)}</div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Cache Management Section ───────────────────────────────────────────────────

function CacheManagementSection() {
  const [status, setStatus] = useState<Record<string, CacheCategory> | null>(null)
  const [clearing, setClearing] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/cache/status')
      if (res.ok) setStatus(await res.json())
    } catch {
      // Silent fail
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  const handleClear = async (type: string) => {
    setClearing(type)
    try {
      await fetch('/api/admin/cache/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ types: [type] }),
      })
      await loadStatus()
    } catch {
      // Silent fail
    } finally {
      setClearing(null)
    }
  }

  const CACHE_LABELS: Record<string, string> = {
    briefs: 'Customer Briefs',
    meetings: 'Meeting Cache',
    emails: 'Email Cache',
    productIntel: 'Product Intelligence',
    industryAnalysis: 'Industry Analysis',
  }

  return (
    <div className="mt-4 space-y-2">
      {status &&
        Object.entries(CACHE_LABELS).map(([key, label]) => {
          const cat = status[key]
          if (!cat) return null
          return (
            <div key={key} className="flex items-center justify-between py-2 border-b border-gray-700 last:border-0">
              <div className="flex-1">
                <div className="text-sm text-gray-200">{label}</div>
                <div className="text-xs text-gray-400">
                  {cat.count} file{cat.count !== 1 ? 's' : ''}
                  {cat.oldestAt && <> · oldest {formatRelTime(cat.oldestAt)}</>}
                </div>
              </div>
              <button
                onClick={() => handleClear(key)}
                disabled={clearing !== null || cat.count === 0}
                aria-label={`Clear ${label} cache`}
                className="px-2.5 py-1 text-xs font-medium rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-40 text-white transition-colors"
              >
                {clearing === key ? 'Clearing…' : 'Clear'}
              </button>
            </div>
          )
        })}
    </div>
  )
}

// ── Main Panel ─────────────────────────────────────────────────────────────────

export function OperationsPanel() {
  return (
    <div className="space-y-3">
      <CollapsibleSection title="Scraper Health" defaultOpen={true}>
        <ScraperHealthSection />
      </CollapsibleSection>

      <CollapsibleSection title="Scrape History">
        <ScrapeHistorySection />
      </CollapsibleSection>

      <CollapsibleSection title="Gemini Usage" defaultOpen={true}>
        <GeminiUsageSection />
      </CollapsibleSection>

      <CollapsibleSection title="Cache Management">
        <CacheManagementSection />
      </CollapsibleSection>
    </div>
  )
}
