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

// ── Intelligence Graph Section (#524) ──────────────────────────────────────────

interface GraphGenerateAllResult {
  total: number
  graphsBuilt: number
  motionsGenerated: number
  errors: Array<{ customer: string; error: string }>
  durationMs: number
}

interface GraphGenerateAllState {
  status: 'idle' | 'running' | 'complete'
  result?: GraphGenerateAllResult
  startedAt?: string
}

function IntelligenceGraphSection() {
  const [state, setState] = useState<GraphGenerateAllState>({ status: 'idle' })
  const [triggering, setTriggering] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (state.status !== 'running') return
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/intelligence-graph/generate-all/status')
        if (res.ok) setState(await res.json())
      } catch { /* silent */ }
    }, 3000)
    return () => clearInterval(interval)
  }, [state.status])

  useEffect(() => {
    fetch('/api/intelligence-graph/generate-all/status')
      .then(r => r.json())
      .then(d => setState(d))
      .catch(() => {})
  }, [])

  const handleGenerateAll = async () => {
    setTriggering(true)
    setError(null)
    try {
      const res = await fetch('/api/intelligence-graph/generate-all', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError((data as { error?: string }).error ?? `Failed (${res.status})`)
        return
      }
      const data = await res.json()
      setState({ status: 'running', startedAt: data.startedAt })
    } catch (e: any) {
      setError(e?.message ?? 'Network error')
    } finally {
      setTriggering(false)
    }
  }

  const result = state.result

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          onClick={handleGenerateAll}
          disabled={triggering || state.status === 'running'}
          className="px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white transition-colors flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${state.status === 'running' ? 'animate-spin' : ''}`} />
          <span>{state.status === 'running' ? 'Running...' : 'Generate All Graphs'}</span>
        </button>
        {state.status === 'running' && state.startedAt && (
          <span className="text-xs text-yellow-400">Started {new Date(state.startedAt).toLocaleTimeString()}</span>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 rounded px-3 py-2">{error}</div>
      )}

      {result && state.status === 'complete' && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div className="bg-gray-900/50 rounded p-3">
              <div className="text-gray-400 mb-1">Graphs Built</div>
              <div className="text-gray-200 text-lg font-medium">{result.graphsBuilt} / {result.total}</div>
            </div>
            <div className="bg-gray-900/50 rounded p-3">
              <div className="text-gray-400 mb-1">Motions Generated</div>
              <div className="text-gray-200 text-lg font-medium">{result.motionsGenerated}</div>
            </div>
            <div className="bg-gray-900/50 rounded p-3">
              <div className="text-gray-400 mb-1">Duration</div>
              <div className="text-gray-200 text-lg font-medium">
                {result.durationMs >= 60000 ? `${Math.round(result.durationMs / 60000)}m` : `${Math.round(result.durationMs / 1000)}s`}
              </div>
            </div>
          </div>
          {result.errors.length > 0 && (
            <div className="text-xs">
              <div className="text-red-400 font-medium mb-1">{result.errors.length} error{result.errors.length !== 1 ? 's' : ''}</div>
              {result.errors.slice(0, 5).map((err, i) => (
                <div key={i} className="text-gray-400 truncate" title={err.error}>{err.customer}: {err.error}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Intelligence Graph Viewer (#525) ─────────────────────────────────────────

interface DebugNode {
  id: string
  type: string
  name: string
}

interface DebugEdge {
  from: string
  to: string
  relation: string
  tier: 'factual' | 'derived'
  strength: number
}

interface GraphDebugData {
  nodeCount: number
  edgeCount: number
  edgeTypes: Record<string, number>
  builtAt?: string
  nodes: DebugNode[]
  edges: DebugEdge[]
  motionTitle?: string
}

interface AeCustomer {
  name: string
  slug?: string
}

interface AeEntry {
  name: string
  customers: AeCustomer[]
}

function IntelligenceGraphViewer() {
  const [customers, setCustomers] = useState<Array<{ name: string; slug: string }>>([])
  const [selectedSlug, setSelectedSlug] = useState<string>('')
  const [graphData, setGraphData] = useState<GraphDebugData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedNodeTypes, setExpandedNodeTypes] = useState<Set<string>>(new Set())
  const [expandedRelations, setExpandedRelations] = useState<Set<string>>(new Set())
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildError, setRebuildError] = useState<string | null>(null)

  // Load customer list from /api/accounts
  useEffect(() => {
    fetch('/api/accounts')
      .then(r => r.json())
      .then((data: { customers?: Array<{ name: string; slug?: string }> }) => {
        const all = (data.customers ?? []).map(c => ({
          name: c.name,
          slug: c.slug ?? c.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
        }))
        all.sort((a, b) => a.name.localeCompare(b.name))
        setCustomers(all)
      })
      .catch(() => {})
  }, [])

  // Fetch graph debug data when a customer is selected
  const loadGraph = useCallback(async (slug: string) => {
    if (!slug) { setGraphData(null); return }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/customer/${slug}/graph/debug`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error ?? `Failed (${res.status})`)
        setGraphData(null)
        return
      }
      const data: GraphDebugData = await res.json()
      setGraphData(data)
      setExpandedNodeTypes(new Set())
      setExpandedRelations(new Set())
    } catch (e: any) {
      setError(e?.message ?? 'Network error')
      setGraphData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (selectedSlug) loadGraph(selectedSlug)
  }, [selectedSlug, loadGraph])

  const handleRebuild = async () => {
    if (!selectedSlug) return
    setRebuilding(true)
    setRebuildError(null)
    try {
      const res = await fetch(`/api/customer/${selectedSlug}/expansion-motion`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setRebuildError((body as { error?: string }).error ?? `Failed (${res.status})`)
        return
      }
      // Reload graph data after rebuild
      await loadGraph(selectedSlug)
    } catch (e: any) {
      setRebuildError(e?.message ?? 'Network error')
    } finally {
      setRebuilding(false)
    }
  }

  const toggleNodeType = (type: string) => {
    setExpandedNodeTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const toggleRelation = (rel: string) => {
    setExpandedRelations(prev => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }

  // Group nodes by type
  const nodesByType: Record<string, DebugNode[]> = {}
  if (graphData) {
    for (const node of graphData.nodes) {
      if (!nodesByType[node.type]) nodesByType[node.type] = []
      nodesByType[node.type].push(node)
    }
  }

  // Group edges by relation
  const edgesByRelation: Record<string, DebugEdge[]> = {}
  if (graphData) {
    for (const edge of graphData.edges) {
      if (!edgesByRelation[edge.relation]) edgesByRelation[edge.relation] = []
      edgesByRelation[edge.relation].push(edge)
    }
  }

  // Build a node name lookup for edge display
  const nodeNames: Record<string, string> = {}
  if (graphData) {
    for (const node of graphData.nodes) {
      nodeNames[node.id] = node.name
    }
  }

  const truncateId = (id: string) => id.length > 32 ? id.slice(0, 32) + '...' : id

  return (
    <div className="space-y-3">
      {/* Customer selector */}
      <div className="flex items-center gap-3">
        <select
          value={selectedSlug}
          onChange={(e) => setSelectedSlug(e.target.value)}
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-500"
        >
          <option value="">Select a customer...</option>
          {customers.map(c => (
            <option key={c.slug} value={c.slug}>{c.name}</option>
          ))}
        </select>
        <button
          onClick={handleRebuild}
          disabled={!selectedSlug || rebuilding}
          className="px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white transition-colors flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${rebuilding ? 'animate-spin' : ''}`} />
          <span>{rebuilding ? 'Rebuilding...' : 'Rebuild Graph'}</span>
        </button>
      </div>

      {rebuildError && (
        <div className="text-xs text-red-400 bg-red-900/20 rounded px-3 py-2">{rebuildError}</div>
      )}

      {loading && (
        <div className="text-xs text-gray-400">Loading graph data...</div>
      )}

      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 rounded px-3 py-2">{error}</div>
      )}

      {graphData && !loading && (
        <div className="space-y-3">
          {/* Summary card */}
          <div className="grid grid-cols-4 gap-3 text-xs">
            <div className="bg-gray-900/50 rounded p-3">
              <div className="text-gray-400 mb-1">Nodes</div>
              <div className="text-gray-200 text-lg font-medium">{graphData.nodeCount}</div>
            </div>
            <div className="bg-gray-900/50 rounded p-3">
              <div className="text-gray-400 mb-1">Edges</div>
              <div className="text-gray-200 text-lg font-medium">{graphData.edgeCount}</div>
            </div>
            <div className="bg-gray-900/50 rounded p-3">
              <div className="text-gray-400 mb-1">Built At</div>
              <div className="text-gray-200 text-sm">
                {graphData.builtAt ? new Date(graphData.builtAt).toLocaleString() : 'Never'}
              </div>
            </div>
            <div className="bg-gray-900/50 rounded p-3">
              <div className="text-gray-400 mb-1">Motion</div>
              <div className="text-gray-200 text-sm truncate" title={graphData.motionTitle ?? 'None'}>
                {graphData.motionTitle ?? 'None'}
              </div>
            </div>
          </div>

          {/* Node table - grouped by type */}
          {Object.keys(nodesByType).length > 0 && (
            <div>
              <div className="text-xs font-medium text-gray-400 mb-2">Nodes by Type</div>
              <div className="space-y-1">
                {Object.entries(nodesByType)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([type, nodes]) => (
                    <div key={type} className="bg-gray-900/30 rounded">
                      <button
                        onClick={() => toggleNodeType(type)}
                        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-gray-700/30 transition-colors"
                      >
                        <span className="text-gray-300 font-medium">
                          {type} <span className="text-gray-500 font-normal">({nodes.length})</span>
                        </span>
                        {expandedNodeTypes.has(type)
                          ? <ChevronDown className="w-3 h-3 text-gray-500" />
                          : <ChevronRight className="w-3 h-3 text-gray-500" />}
                      </button>
                      {expandedNodeTypes.has(type) && (
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-gray-700 text-gray-500">
                              <th className="text-left px-3 py-1">ID</th>
                              <th className="text-left px-3 py-1">Name</th>
                            </tr>
                          </thead>
                          <tbody>
                            {nodes.map(node => (
                              <tr key={node.id} className="border-b border-gray-800 text-gray-400">
                                <td className="px-3 py-1 font-mono" title={node.id}>{truncateId(node.id)}</td>
                                <td className="px-3 py-1 text-gray-300">{node.name}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Edge table - grouped by relation */}
          {Object.keys(edgesByRelation).length > 0 && (
            <div>
              <div className="text-xs font-medium text-gray-400 mb-2">Edges by Relation</div>
              <div className="space-y-1">
                {Object.entries(edgesByRelation)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([relation, edges]) => (
                    <div key={relation} className="bg-gray-900/30 rounded">
                      <button
                        onClick={() => toggleRelation(relation)}
                        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-gray-700/30 transition-colors"
                      >
                        <span className="text-gray-300 font-medium">
                          {relation} <span className="text-gray-500 font-normal">({edges.length})</span>
                        </span>
                        {expandedRelations.has(relation)
                          ? <ChevronDown className="w-3 h-3 text-gray-500" />
                          : <ChevronRight className="w-3 h-3 text-gray-500" />}
                      </button>
                      {expandedRelations.has(relation) && (
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-gray-700 text-gray-500">
                              <th className="text-left px-3 py-1">From</th>
                              <th className="text-left px-3 py-1">To</th>
                              <th className="text-left px-3 py-1">Tier</th>
                              <th className="text-right px-3 py-1">Strength</th>
                            </tr>
                          </thead>
                          <tbody>
                            {edges.map((edge, i) => (
                              <tr key={i} className="border-b border-gray-800 text-gray-400">
                                <td className="px-3 py-1 text-gray-300">{nodeNames[edge.from] ?? truncateId(edge.from)}</td>
                                <td className="px-3 py-1 text-gray-300">{nodeNames[edge.to] ?? truncateId(edge.to)}</td>
                                <td className="px-3 py-1">
                                  <span className={edge.tier === 'factual' ? 'text-green-400' : 'text-yellow-400'}>
                                    {edge.tier}
                                  </span>
                                </td>
                                <td className="px-3 py-1 text-right font-mono">{edge.strength.toFixed(2)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}

          {graphData.nodeCount === 0 && (
            <div className="text-xs text-gray-500">No graph data. Click "Rebuild Graph" to generate.</div>
          )}
        </div>
      )}

      {!selectedSlug && !loading && (
        <div className="text-xs text-gray-500">Select a customer to view their intelligence graph.</div>
      )}
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

      <CollapsibleSection title="Intelligence Graph" defaultOpen={true}>
        <IntelligenceGraphSection />
      </CollapsibleSection>

      <CollapsibleSection title="Intelligence Graph Viewer" defaultOpen={false}>
        <IntelligenceGraphViewer />
      </CollapsibleSection>

      <CollapsibleSection title="Cache Management">
        <CacheManagementSection />
      </CollapsibleSection>
    </div>
  )
}
