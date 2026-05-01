// BKL-M50d: Session Health Panel
// At-a-glance session health for all data sources.
// BKL-ARCH-05: migrated to usePolledStatus — 3 independent 30s polls instead
// of one combined Promise.all. Each tile updates as its source returns.

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Shield, Activity, Cloud } from 'lucide-react'
import RelTime from './RelTime'
import { useNodeRole } from '../hooks/useNodeRole'
import { usePolledStatus } from '../hooks/usePolledStatus'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RhStatus {
  hasSession: boolean
  sessionExpired: boolean
  lastScraped: string | null
  caseCount: number
}

interface SfStatus {
  hasSession: boolean
  sessionExpired?: boolean
  lastSync: string | null
  rowCount: number
  syncError?: string | null
}

interface ScraperEntry {
  state: 'fresh' | 'stale' | 'failed' | 'running'
  lastRun: string | null
  lastSuccess: string | null
  lastError: string | null
  recordCount: number
}

interface HealthData {
  rh: RhStatus | null
  sf: SfStatus | null
  ccsp: ScraperEntry | null
  supportable: ScraperEntry | null
}

type StatusBadgeVariant = 'active' | 'expired' | 'unknown' | 'no-session'

// ── Badge ─────────────────────────────────────────────────────────────────────

function StatusBadge({ variant }: { variant: StatusBadgeVariant }) {
  const cfg: Record<StatusBadgeVariant, { label: string; classes: string }> = {
    active:      { label: 'Active',     classes: 'bg-green-900/60 text-green-400 border border-green-700/50' },
    expired:     { label: 'Expired',    classes: 'bg-red-900/60 text-red-400 border border-red-700/50' },
    'no-session':{ label: 'No Session', classes: 'bg-amber-900/60 text-amber-400 border border-amber-700/50' },
    unknown:     { label: 'Unknown',    classes: 'bg-gray-700/60 text-gray-400 border border-gray-600/50' },
  }
  const { label, classes } = cfg[variant]
  return (
    <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${classes}`}>
      {label}
    </span>
  )
}

// ── Skeleton tile ─────────────────────────────────────────────────────────────

function SkeletonTile() {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 animate-pulse">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-4 h-4 bg-gray-700 rounded" />
        <div className="w-20 h-3 bg-gray-700 rounded" />
      </div>
      <div className="w-14 h-4 bg-gray-700 rounded mb-2" />
      <div className="w-24 h-2.5 bg-gray-700 rounded mb-1.5" />
      <div className="w-16 h-2.5 bg-gray-700 rounded" />
    </div>
  )
}

// ── Individual tiles ──────────────────────────────────────────────────────────

function RhTile({ rh }: { rh: RhStatus }) {
  const variant: StatusBadgeVariant =
    !rh.hasSession ? 'no-session'
    : rh.sessionExpired ? 'expired'
    : 'active'

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-red-400 shrink-0" />
          <span className="text-xs font-medium text-gray-200">RH Portal</span>
        </div>
        <StatusBadge variant={variant} />
      </div>
      <div className="space-y-1 text-xs text-gray-400">
        {rh.lastScraped ? (
          <div>Last sync: <RelTime iso={rh.lastScraped} className="text-gray-300" /></div>
        ) : (
          <div className="text-gray-500">Never synced</div>
        )}
        <div>{rh.caseCount} case{rh.caseCount !== 1 ? 's' : ''}</div>
        {variant !== 'active' && (
          <Link to="/dashboard/setup" className="text-blue-400 hover:text-blue-300 underline text-[10px]">
            Reconnect →
          </Link>
        )}
      </div>
    </div>
  )
}

function SfTile({ sf }: { sf: SfStatus }) {
  // Any non-null syncError degrades status — not just 'session expired' string matches
  const expired = sf.sessionExpired || !!sf.syncError
  const variant: StatusBadgeVariant =
    !sf.hasSession ? 'no-session'
    : expired ? 'expired'
    : 'active'

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Cloud className="w-4 h-4 text-blue-400 shrink-0" />
          <span className="text-xs font-medium text-gray-200">Salesforce</span>
        </div>
        <StatusBadge variant={variant} />
      </div>
      <div className="space-y-1 text-xs text-gray-400">
        {sf.lastSync ? (
          <div>Last sync: <RelTime iso={sf.lastSync} className="text-gray-300" /></div>
        ) : (
          <div className="text-gray-500">Never synced</div>
        )}
        <div>{sf.rowCount} row{sf.rowCount !== 1 ? 's' : ''}</div>
        {variant !== 'active' && (
          <Link to="/dashboard/setup" className="text-blue-400 hover:text-blue-300 underline text-[10px]">
            Reconnect →
          </Link>
        )}
      </div>
    </div>
  )
}

function ScraperTile({
  label,
  icon: Icon,
  entry,
  iconClass,
}: {
  label: string
  icon: React.ElementType
  entry: ScraperEntry
  iconClass: string
}) {
  const variant: StatusBadgeVariant =
    entry.state === 'fresh' || entry.state === 'running' ? 'active'
    : entry.state === 'failed' ? 'expired'
    : entry.lastSuccess ? 'unknown'
    : 'no-session'

  const lastTime = entry.lastSuccess ?? entry.lastRun

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 shrink-0 ${iconClass}`} />
          <span className="text-xs font-medium text-gray-200">{label}</span>
        </div>
        <StatusBadge variant={variant} />
      </div>
      <div className="space-y-1 text-xs text-gray-400">
        {lastTime ? (
          <div>Last run: <RelTime iso={lastTime} className="text-gray-300" /></div>
        ) : (
          <div className="text-gray-500">Never run</div>
        )}
        <div>{entry.recordCount} record{entry.recordCount !== 1 ? 's' : ''}</div>
        {entry.state === 'running' && (
          <div className="flex items-center gap-1 text-yellow-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
            Running…
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface ScraperStatusResponse {
  scrapers?: Record<string, ScraperEntry>
}

export function SessionHealthPanel() {
  const { isL3Only } = useNodeRole()
  const { data: rhStatus } = usePolledStatus<RhStatus>(
    '/api/auth/redhat/status',
    { intervalMs: 30_000 },
  )
  const { data: sfStatus } = usePolledStatus<SfStatus>(
    '/api/auth/salesforce/status',
    { intervalMs: 30_000 },
  )
  const { data: scraperStatus } = usePolledStatus<ScraperStatusResponse>(
    '/api/scraper-status',
    { intervalMs: 30_000 },
  )

  // Initial render shows skeletons until at least one source returns. After
  // that, we render whatever has loaded — independent tiles, no all-or-nothing.
  const data: HealthData | null = useMemo(() => {
    if (rhStatus === null && sfStatus === null && scraperStatus === null) return null
    return {
      rh: rhStatus,
      sf: sfStatus,
      ccsp: scraperStatus?.scrapers?.ccsp ?? null,
      supportable: scraperStatus?.scrapers?.supportable ?? null,
    }
  }, [rhStatus, sfStatus, scraperStatus])

  const isLoading = data === null

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Data Source Health</h2>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        {isLoading ? (
          <>
            <SkeletonTile />
            <SkeletonTile />
            <SkeletonTile />
            <SkeletonTile />
          </>
        ) : (
          <>
            {/* BKL-HERO-10: hide RH Portal tile in L3 hero mode */}
            {!isL3Only && (
              data.rh ? (
                <RhTile rh={data.rh} />
              ) : (
                <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="w-4 h-4 text-red-400 shrink-0" />
                    <span className="text-xs font-medium text-gray-200">RH Portal</span>
                  </div>
                  <StatusBadge variant="unknown" />
                </div>
              )
            )}
            {data.sf ? (
              <SfTile sf={data.sf} />
            ) : (
              <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Cloud className="w-4 h-4 text-blue-400 shrink-0" />
                  <span className="text-xs font-medium text-gray-200">Salesforce</span>
                </div>
                <StatusBadge variant="unknown" />
              </div>
            )}
            {/* BKL-HERO-10: hide Tableau/CCSP tile in L3 hero mode */}
            {!isL3Only && (
              data.ccsp ? (
                <ScraperTile
                  label="Tableau / CCSP"
                  icon={Activity}
                  entry={data.ccsp}
                  iconClass="text-purple-400"
                />
              ) : (
                <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Activity className="w-4 h-4 text-purple-400 shrink-0" />
                    <span className="text-xs font-medium text-gray-200">Tableau / CCSP</span>
                  </div>
                  <StatusBadge variant="unknown" />
                </div>
              )
            )}
          </>
        )}
      </div>
    </div>
  )
}
