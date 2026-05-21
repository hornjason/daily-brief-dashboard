import { useState, useEffect } from 'react'
import { Circle } from 'lucide-react'
import { formatRelTime } from '../../lib/format'

// ── Types ──────────────────────────────────────────────────────────────────────

interface ModuleComplianceData {
  score: number
  signalProducers: number
  withEnsureFresh: number
  compliant: string[]
  advisory: string[]
}

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
}: {
  title: string
  mainText: string
  subtitle?: string
  progressPercent?: number
  statusColor?: 'green' | 'yellow' | 'red' | 'gray'
}) {
  const colorClasses = {
    green: 'text-green-400 bg-green-400',
    yellow: 'text-yellow-400 bg-yellow-400',
    red: 'text-red-400 bg-red-400',
    gray: 'text-gray-400 bg-gray-400',
  }

  const statusClass = statusColor ? colorClasses[statusColor] : ''

  return (
    <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
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
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function SystemOverviewPanel() {
  const [compliance, setCompliance] = useState<ModuleComplianceData | null>(null)
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([])
  const [freshness, setFreshness] = useState<DataFreshnessStatus | null>(null)

  const loadData = async () => {
    try {
      // Fetch compliance data
      const compRes = await fetch('/api/modules/compliance')
      if (compRes.ok) {
        const compData: ModuleComplianceData = await compRes.json()
        setCompliance(compData)
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
  const errorCount = scheduledTasks.filter(t => t.state === 'error').length
  const freshCount = freshness?.sources.filter(s => s.status === 'fresh').length ?? 0
  const staleCount = freshness?.sources.filter(s => s.status === 'stale').length ?? 0
  const totalSources = freshness?.sources.length ?? 0

  const taskStatusColor: 'green' | 'yellow' | 'red' | 'gray' = errorCount > 0
    ? 'red'
    : runningCount > 0
      ? 'yellow'
      : scheduledTasks.length > 0
        ? 'green'
        : 'gray'

  const freshnessStatusColor: 'green' | 'yellow' | 'red' | 'gray' =
    staleCount > 0 ? 'yellow' : freshCount === totalSources && totalSources > 0 ? 'green' : 'gray'

  return (
    <div className="space-y-6">
      {/* Summary Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Module Health */}
        <SummaryCard
          title="Module Health"
          mainText={`${compliance?.score ?? 0}% — ${compliance?.withEnsureFresh ?? 0}/${compliance?.signalProducers ?? 0} modules`}
          subtitle="How many data modules follow best practices"
          progressPercent={compliance?.score ?? 0}
        />

        {/* Automated Tasks */}
        <SummaryCard
          title="Automated Tasks"
          mainText={`${scheduledTasks.length} tasks — ${runningCount > 0 ? `${runningCount} running` : 'all idle'}`}
          subtitle="Background jobs that keep data current"
          statusColor={taskStatusColor}
        />

        {/* Data Currency */}
        <SummaryCard
          title="Data Currency"
          mainText={`${freshCount}/${totalSources} fresh — ${staleCount} stale`}
          subtitle="How current your customer data is"
          statusColor={freshnessStatusColor}
        />

        {/* Auto-Refresh Coverage */}
        <SummaryCard
          title="Auto-Refresh Coverage"
          mainText={`${compliance?.withEnsureFresh ?? 0}/${compliance?.signalProducers ?? 0} auto-refresh`}
          subtitle="Modules that refresh data before generating content"
          progressPercent={
            compliance
              ? Math.round((compliance.withEnsureFresh / compliance.signalProducers) * 100)
              : 0
          }
        />
      </div>

      {/* Scheduled Tasks Table */}
      <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
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
      </div>
    </div>
  )
}
