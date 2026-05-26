import { useState, useEffect } from 'react'
import { Circle } from 'lucide-react'
import { formatRelTime } from '../../lib/format'

// ── Types ──────────────────────────────────────────────────────────────────────

interface ScheduledTask {
  name: string
  type: 'daily' | 'interval' | 'weekly'
  schedule: string
  nextRun: string | null
  lastRun: string | null
  state: 'idle' | 'running' | 'queued' | 'error'
  error: string | null
  intervalMs?: number
  hour?: number
  minute?: number
  dayOfWeek?: number
  day?: string
}

// ── Humanize interval ──────────────────────────────────────────────────────────

function humanizeInterval(ms: number): string {
  const hours = Math.floor(ms / 3600000)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days} day${days !== 1 ? 's' : ''}`
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''}`
  const minutes = Math.floor(ms / 60000)
  return `${minutes} minute${minutes !== 1 ? 's' : ''}`
}

function getScheduleDisplay(task: ScheduledTask): string {
  if (task.type === 'interval' && task.intervalMs) {
    return `Every ${humanizeInterval(task.intervalMs)}`
  }
  if (task.type === 'daily' && task.hour !== undefined && task.minute !== undefined) {
    const h = String(task.hour).padStart(2, '0')
    const m = String(task.minute).padStart(2, '0')
    return `Daily at ${h}:${m} ET`
  }
  if (task.type === 'weekly' && task.dayOfWeek !== undefined && task.hour !== undefined && task.minute !== undefined) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const dayName = days[task.dayOfWeek] ?? `Day ${task.dayOfWeek}`
    const h = String(task.hour).padStart(2, '0')
    const m = String(task.minute).padStart(2, '0')
    return `Weekly ${dayName} at ${h}:${m} ET`
  }
  return '—'
}

function getNextRunDisplay(task: ScheduledTask): string {
  if (task.nextRun) return formatRelTime(task.nextRun)
  // For interval tasks with no nextRun but has lastRun, compute from lastRun + intervalMs
  if (task.type === 'interval' && task.intervalMs && task.lastRun) {
    const lastRunTime = new Date(task.lastRun).getTime()
    const computedNext = new Date(lastRunTime + task.intervalMs).toISOString()
    return formatRelTime(computedNext)
  }
  if (task.type === 'interval' && task.intervalMs && !task.lastRun) {
    return 'Pending'
  }
  return '—'
}

interface SchedulerStatusResponse {
  entries: ScheduledTask[]
}

interface DataFreshnessStatus {
  sources: Array<{
    status: 'fresh' | 'stale' | 'critical' | 'unknown'
  }>
}

// ── Task Descriptions ──────────────────────────────────────────────────────────

const TASK_DESCRIPTIONS: Record<string, string> = {
  'news-radar': 'Fetches latest news about your customers',
  'kpi-snapshot': 'Captures daily portfolio metrics',
  'product-intel': 'Updates product release notes and features',
  'product-lifecycle': 'Checks product end-of-life dates',
  'rh-rss': 'Pulls Red Hat blog and press releases',
  'rh-events': 'Updates Red Hat event calendar',
}

// ── Summary Cards ──────────────────────────────────────────────────────────────

function SummaryCard({
  title,
  mainText,
  subtitle,
  progressPercent,
  statusColor,
  selected,
  onClick,
}: {
  title: string
  mainText: string
  subtitle?: string
  progressPercent?: number
  statusColor?: 'green' | 'yellow' | 'red' | 'gray'
  selected?: boolean
  onClick?: () => void
}) {
  const colorClasses = {
    green: 'text-green-400 bg-green-400',
    yellow: 'text-yellow-400 bg-yellow-400',
    red: 'text-red-400 bg-red-400',
    gray: 'text-gray-400 bg-gray-400',
  }

  const statusClass = statusColor ? colorClasses[statusColor] : ''

  return (
    <button
      onClick={onClick}
      className={`bg-gray-800 rounded-lg p-3 border transition-colors text-left w-full ${
        selected ? 'border-blue-500 ring-1 ring-blue-500/30' : 'border-gray-700 hover:border-gray-600'
      }`}
    >
      <div className="text-xs font-medium text-gray-400 mb-1">{title}</div>
      <div className="flex items-center gap-2 mb-1">
        <div className="text-lg font-medium text-gray-100">{mainText}</div>
        {statusColor && <Circle className={`w-2 h-2 fill-current ${statusClass}`} />}
      </div>
      {subtitle && <div className="text-xs text-gray-400">{subtitle}</div>}
      {progressPercent !== undefined && (
        <div className="w-full bg-gray-700 rounded-full h-2 mt-2">
          <div
            className={`h-2 rounded-full transition-all ${
              progressPercent >= 80
                ? 'bg-green-400'
                : progressPercent >= 50
                  ? 'bg-yellow-400'
                  : 'bg-red-400'
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}
    </button>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────

interface HealthModule {
  name: string
  status: 'healthy' | 'warning' | 'error'
  warnings: string[]
  signalCount: number
  scope?: 'portfolio' | 'customer' | 'both'
}

type DetailPanel = 'quality' | 'tasks' | 'currency' | 'coverage' | 'crossref' | null

interface CrossrefCustomer {
  name: string; slug: string
  ownedProducts: string[]; interestProducts: string[]
  portfolioSignals: number; matchedSignals: number
  subscriptionMatches: number; interestMatches: number
}

interface CrossrefStatus {
  customers: CrossrefCustomer[]
  totals: {
    customersWithProducts: number; totalPortfolioSignals: number
    matchedSignals: number; subscriptionMatches: number; interestMatches: number
  }
}

const FRIENDLY_NAMES: Record<string, string> = {
  'news-radar': 'Customer News', 'product-lifecycle': 'Product End-of-Life Dates',
  'rh-rss': 'Red Hat Blog & Press', 'rh-events': 'Red Hat Events',
  'product-intel': 'Product Features & Releases', 'ccsp': 'Cloud Spend (CCSP)',
  'value-maps': 'Business Value Maps', 'cases': 'Support Cases',
  'subscriptions': 'Subscriptions', 'pipeline': 'Sales Pipeline',
  'customer-docs': 'Customer Drive Documents', 'customer-product-intel': 'Product Talking Points',
  'emails': 'Email History', 'intelligence': 'Company Intelligence',
  'account-plan': 'Account Plans', 'cloud-marketplace': 'Cloud Marketplace Programs',
  'tech-stack': 'Technology Detection', 'playbook': 'Engagement Playbook',
  'campaigns': 'Email Campaigns', 'meeting-prep': 'Meeting Prep', 'tools': 'Business Value Tools',
  'solution-intelligence': 'Solution Intelligence', 'mergers-acquisitions': 'Mergers & Acquisitions',
  'competitive-intel': 'Competitive Intelligence', 'saleshub': 'Sales Hub',
  'partner-catalog': 'Partner Catalog', 'value-positioning': 'Value Positioning',
}

export function SystemOverviewPanel() {
  const [health, setHealth] = useState<HealthModule[]>([])
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([])
  const [freshness, setFreshness] = useState<DataFreshnessStatus | null>(null)
  const [crossref, setCrossref] = useState<CrossrefStatus | null>(null)
  const [activeDetail, setActiveDetail] = useState<DetailPanel>(null)

  const loadData = async () => {
    try {
      // Fetch module health (errors/warnings)
      const healthRes = await fetch('/api/modules/health')
      if (healthRes.ok) {
        const healthData = await healthRes.json()
        setHealth(healthData.modules ?? [])
      }

      // Fetch scheduler status
      const schedRes = await fetch('/api/admin/scheduler-status')
      if (schedRes.ok) {
        const schedData: SchedulerStatusResponse = await schedRes.json()
        setScheduledTasks(schedData.entries)
      }

      // Fetch freshness data
      const freshRes = await fetch('/api/status/freshness')
      if (freshRes.ok) {
        const freshData: DataFreshnessStatus = await freshRes.json()
        setFreshness(freshData)
      }

      // Fetch cross-reference status (ADR-029)
      const crossrefRes = await fetch('/api/admin/signal-crossref-status')
      if (crossrefRes.ok) {
        setCrossref(await crossrefRes.json())
      }
    } catch (err) {
      console.error('Failed to load system overview data:', err)
    }
  }

  useEffect(() => {
    loadData()

    // Auto-refresh every 30 seconds
    const interval = setInterval(() => {
      loadData()
    }, 30000)

    return () => clearInterval(interval)
  }, [])

  // Calculate summary metrics
  const runningCount = scheduledTasks.filter(t => t.state === 'running').length
  const taskErrorCount = scheduledTasks.filter(t => t.state === 'error').length
  const freshCount = freshness?.sources.filter(s => s.status === 'fresh').length ?? 0
  const staleCount = freshness?.sources.filter(s => s.status === 'stale').length ?? 0
  const totalSources = freshness?.sources.length ?? 0

  // Health metrics
  const healthErrors = health.filter(m => m.status === 'error').length
  const healthWarnings = health.filter(m => m.status === 'warning').length
  const healthHealthy = health.filter(m => m.status === 'healthy').length
  const totalSignals = health.reduce((sum, m) => sum + m.signalCount, 0)

  const healthColor: 'green' | 'yellow' | 'red' | 'gray' =
    healthErrors > 0 ? 'red' : healthWarnings > 0 ? 'yellow' : health.length > 0 ? 'green' : 'gray'

  const taskStatusColor: 'green' | 'yellow' | 'red' | 'gray' = taskErrorCount > 0
    ? 'red'
    : runningCount > 0
      ? 'yellow'
      : scheduledTasks.length > 0
        ? 'green'
        : 'gray'

  const freshnessStatusColor: 'green' | 'yellow' | 'red' | 'gray' =
    staleCount > 0 ? 'yellow' : freshCount === totalSources && totalSources > 0 ? 'green' : 'gray'

  const crossrefTotal = crossref?.totals.totalPortfolioSignals ?? 0
  const crossrefMatched = crossref?.totals.matchedSignals ?? 0
  const crossrefMatchRate = crossrefTotal > 0 ? crossrefMatched / crossrefTotal : 0
  const crossrefColor: 'green' | 'yellow' | 'red' | 'gray' =
    crossrefTotal === 0 ? 'gray' : crossrefMatchRate > 0.5 ? 'green' : crossrefMatchRate > 0.2 ? 'yellow' : 'red'

  return (
    <div className="space-y-6">
      {/* Summary Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <SummaryCard
          title="Signal Quality"
          mainText={healthErrors > 0 ? `${healthErrors} error${healthErrors > 1 ? 's' : ''}` : healthWarnings > 0 ? `${healthWarnings} warning${healthWarnings > 1 ? 's' : ''}` : `${healthHealthy} healthy`}
          subtitle={`${totalSignals} signals across ${health.length} modules — click for details`}
          statusColor={healthColor}
          selected={activeDetail === 'quality'}
          onClick={() => setActiveDetail(activeDetail === 'quality' ? null : 'quality')}
        />

        <SummaryCard
          title="Automated Tasks"
          mainText={`${scheduledTasks.length} tasks — ${runningCount > 0 ? `${runningCount} running` : 'all idle'}`}
          subtitle="Click to see task schedule"
          statusColor={taskStatusColor}
          selected={activeDetail === 'tasks'}
          onClick={() => setActiveDetail(activeDetail === 'tasks' ? null : 'tasks')}
        />

        <SummaryCard
          title="Data Currency"
          mainText={`${freshCount}/${totalSources} fresh — ${staleCount} stale`}
          subtitle="Click to see source freshness"
          statusColor={freshnessStatusColor}
          selected={activeDetail === 'currency'}
          onClick={() => setActiveDetail(activeDetail === 'currency' ? null : 'currency')}
        />

        <SummaryCard
          title="Intelligence Coverage"
          mainText={`${totalSignals} signals`}
          subtitle={`From ${health.filter(m => m.signalCount > 0).length} sources — click for breakdown`}
          statusColor={totalSignals > 0 ? 'green' : 'gray'}
          selected={activeDetail === 'coverage'}
          onClick={() => setActiveDetail(activeDetail === 'coverage' ? null : 'coverage')}
        />

        <SummaryCard
          title="Cross-Reference"
          mainText={`${crossrefMatched}/${crossrefTotal}`}
          subtitle={`${crossref?.totals.customersWithProducts ?? 0} customers with products`}
          statusColor={crossrefColor}
          selected={activeDetail === 'crossref'}
          onClick={() => setActiveDetail(activeDetail === 'crossref' ? null : 'crossref')}
        />
      </div>

      {/* ── Detail Panel (expands below selected card) ──────────────────── */}
      {activeDetail === 'quality' && (
        <div className="bg-gray-800 rounded-lg border border-blue-500/30 p-4">
          <h3 className="text-sm font-medium text-gray-200 mb-3">Signal Quality Details</h3>
          <div className="space-y-1.5 text-xs">
            {health.filter(m => m.status === 'error').map(m => (
              <div key={m.name} className="flex items-start gap-2">
                <Circle className="w-2.5 h-2.5 fill-current text-red-400 mt-0.5 shrink-0" />
                <div>
                  <span className="text-gray-200 font-medium">{FRIENDLY_NAMES[m.name] ?? m.name}</span>
                  <span className="text-gray-500"> — {m.signalCount} signals</span>
                  {m.warnings.map((w, i) => <div key={i} className="text-red-400">{w}</div>)}
                </div>
              </div>
            ))}
            {health.filter(m => m.status === 'warning').map(m => {
              const isCustomerScope = m.scope === 'customer'
              return (
                <div key={m.name} className="flex items-start gap-2">
                  <Circle className="w-2.5 h-2.5 fill-current text-yellow-400 mt-0.5 shrink-0" />
                  <div>
                    <span className="text-gray-200 font-medium">{FRIENDLY_NAMES[m.name] ?? m.name}</span>
                    <span className="text-gray-500"> — {m.signalCount} signals</span>
                    {m.warnings.map((w, i) => (
                      <div key={i} className="text-yellow-400">
                        {isCustomerScope && w === 'No signals returned'
                          ? 'Customer-specific — view per account'
                          : w}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
            {health.filter(m => m.status === 'healthy' && m.signalCount > 0).map(m => (
              <div key={m.name} className="flex items-center gap-2">
                <Circle className="w-2.5 h-2.5 fill-current text-green-400 shrink-0" />
                <span className="text-gray-300">{FRIENDLY_NAMES[m.name] ?? m.name}</span>
                <span className="text-gray-500">— {m.signalCount} signals</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeDetail === 'currency' && freshness && (
        <div className="bg-gray-800 rounded-lg border border-blue-500/30 p-4">
          <h3 className="text-sm font-medium text-gray-200 mb-3">Data Source Freshness</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
            {freshness.sources.map((s: any) => (
              <div key={s.name} className="flex items-center gap-2 py-1">
                <Circle className={`w-2.5 h-2.5 fill-current shrink-0 ${
                  s.status === 'fresh' ? 'text-green-400' : s.status === 'stale' ? 'text-yellow-400' : s.status === 'critical' ? 'text-red-400' : 'text-gray-400'
                }`} />
                <span className="text-gray-300">{s.displayName || FRIENDLY_NAMES[s.name] || s.name}</span>
                {s.lastChecked && <span className="text-gray-500 ml-auto">{formatRelTime(s.lastChecked)}</span>}
                {s.recordCount !== null && <span className="text-gray-600">({s.recordCount})</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {activeDetail === 'coverage' && (
        <div className="bg-gray-800 rounded-lg border border-blue-500/30 p-4">
          <h3 className="text-sm font-medium text-gray-200 mb-3">Signal Coverage by Module</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
            {health.filter(m => m.signalCount > 0).sort((a, b) => b.signalCount - a.signalCount).map(m => (
              <div key={m.name} className="flex items-center justify-between py-1">
                <span className="text-gray-300">{FRIENDLY_NAMES[m.name] ?? m.name}</span>
                <span className="text-gray-400 font-mono">{m.signalCount}</span>
              </div>
            ))}
            {health.filter(m => m.signalCount === 0).length > 0 && (
              <div className="col-span-full text-gray-500 pt-1 border-t border-gray-700">
                {health.filter(m => m.signalCount === 0).length} modules with no signals: {health.filter(m => m.signalCount === 0).map(m => FRIENDLY_NAMES[m.name] ?? m.name).join(', ')}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cross-Reference Detail (ADR-029) */}
      {activeDetail === 'crossref' && crossref && (
        <div className="bg-gray-800 rounded-lg border border-blue-500/30 p-4">
          <h3 className="text-sm font-medium text-gray-200 mb-3">Signal Cross-Reference Status</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-700 text-gray-400">
                  <th className="text-left py-2 pr-4">Customer</th>
                  <th className="text-left py-2 pr-4">Owned</th>
                  <th className="text-left py-2 pr-4">Expansion</th>
                  <th className="text-right py-2">Matched</th>
                </tr>
              </thead>
              <tbody>
                {crossref.customers
                  .filter(c => c.portfolioSignals > 0 || c.ownedProducts.length > 0 || c.interestProducts.length > 0)
                  .sort((a, b) => b.matchedSignals - a.matchedSignals)
                  .map(c => (
                    <tr key={c.slug} className="border-b border-gray-700/50">
                      <td className="py-1.5 pr-4 text-gray-300">{c.name}</td>
                      <td className="py-1.5 pr-4">
                        <div className="flex flex-wrap gap-1">
                          {c.ownedProducts.map(p => (
                            <span key={p} className="text-green-400 bg-green-400/10 px-1 py-0.5 rounded text-xs border border-green-400/20 uppercase">{p}</span>
                          ))}
                          {c.ownedProducts.length === 0 && <span className="text-gray-500">—</span>}
                        </div>
                      </td>
                      <td className="py-1.5 pr-4">
                        <div className="flex flex-wrap gap-1">
                          {c.interestProducts.map(p => (
                            <span key={p} className="text-cyan-400 bg-cyan-400/10 px-1 py-0.5 rounded text-xs border border-cyan-400/20 uppercase">{p}</span>
                          ))}
                          {c.interestProducts.length === 0 && <span className="text-gray-500">—</span>}
                        </div>
                      </td>
                      <td className="py-1.5 text-right font-mono">
                        <span className={c.matchedSignals > 0 ? 'text-green-400' : 'text-gray-500'}>
                          {c.matchedSignals}
                        </span>
                        <span className="text-gray-500">/{c.portfolioSignals}</span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 text-xs text-gray-500 border-t border-gray-700 pt-2">
            Totals: {crossref.totals.subscriptionMatches} subscription + {crossref.totals.interestMatches} interest matches across {crossref.totals.customersWithProducts} customers
          </div>
        </div>
      )}

      {/* Scheduled Tasks Table — visible when tasks card is selected */}
      {activeDetail === 'tasks' && <div className="bg-gray-800 rounded-lg border border-blue-500/30 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700">
          <h3 className="text-sm font-medium text-gray-200">Scheduled Tasks</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-700 text-xs text-gray-400">
                <th className="text-left py-2 px-4">Task</th>
                <th className="text-left py-2 px-4">Description</th>
                <th className="text-left py-2 px-4">Type</th>
                <th className="text-left py-2 px-4">Schedule</th>
                <th className="text-left py-2 px-4">Next Run</th>
                <th className="text-left py-2 px-4">Last Run</th>
                <th className="text-left py-2 px-4">State</th>
              </tr>
            </thead>
            <tbody>
              {scheduledTasks.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-4 text-sm text-gray-500">
                    No scheduled tasks
                  </td>
                </tr>
              ) : (
                scheduledTasks.map(task => {
                  const statusColor =
                    task.state === 'error'
                      ? 'text-red-400'
                      : task.state === 'running' || task.state === 'queued'
                        ? 'text-yellow-400'
                        : 'text-green-400'

                  const description = TASK_DESCRIPTIONS[task.name] ?? task.name

                  return (
                    <tr key={task.name} className="border-b border-gray-700 text-sm text-gray-300">
                      <td className="py-2 px-4">{task.name}</td>
                      <td className="py-2 px-4 text-xs text-gray-400">{description}</td>
                      <td className="py-2 px-4 capitalize">{task.type}</td>
                      <td className="py-2 px-4">{getScheduleDisplay(task)}</td>
                      <td className="py-2 px-4">{getNextRunDisplay(task)}</td>
                      <td className="py-2 px-4">
                        {task.lastRun ? formatRelTime(task.lastRun) : '—'}
                      </td>
                      <td className="py-2 px-4">
                        <div className="flex items-center gap-1.5">
                          <Circle className={`w-3 h-3 fill-current ${statusColor}`} />
                          <span className={statusColor}>{task.state}</span>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>}
    </div>
  )
}
