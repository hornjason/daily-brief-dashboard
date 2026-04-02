import { useState, useMemo, useEffect, useCallback } from 'react'
import type { KPIs, SupportCase, AccountInfo, PipelineOpp } from '../types'
import KPICasesModal from './KPICasesModal'
import KPISev1Modal from './KPISev1Modal'
import KPIRenewalsModal, { type RenewalRow } from './KPIRenewalsModal'
import KPITechWinsModal from './KPITechWinsModal'
import SparklineKPI from './SparklineKPI'
import {
  ShieldAlert,
  AlertTriangle,
  CalendarCheck,
  CalendarDays,
  Package,
  Key,
  Trophy,
} from 'lucide-react'

/* ── KPI config persistence (BKL-UX45) ─────────────────────── */

const KPI_STORAGE_KEY = 'kpi-config'

interface KPIConfig {
  order: string[]
  hidden: string[]
}

const DEFAULT_KPI_IDS = [
  'openCases',
  'sev1Cases',
  'meetingsToday',
  'meetingsThisWeek',
  'expiringWithin30',
  'renewals30to90',
  'techWinsNeeded',
]

function loadKPIConfig(): KPIConfig {
  try {
    const raw = localStorage.getItem(KPI_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed.order) && Array.isArray(parsed.hidden)) {
        return parsed as KPIConfig
      }
    }
  } catch {
    // Corrupted or missing — use defaults
  }
  return { order: DEFAULT_KPI_IDS, hidden: [] }
}

function saveKPIConfig(config: KPIConfig): void {
  try {
    localStorage.setItem(KPI_STORAGE_KEY, JSON.stringify(config))
  } catch {
    // localStorage full or unavailable — silently skip
  }
}

/* ── KPICard ────────────────────────────────────────────────── */

interface KPICardProps {
  label: string
  value: number | string
  icon: React.ReactNode
  accent?: string
  loading?: boolean
  onClick?: () => void
  subtitle?: React.ReactNode
  sparklineData?: number[]
  invertTrend?: boolean
}

function KPICard({ label, value, icon, accent, loading, onClick, subtitle, sparklineData, invertTrend }: KPICardProps) {
  return (
    <div
      className={`bg-surface border border-border rounded-xl p-5 min-w-[180px] flex-1 flex items-center gap-4 ${
        onClick ? 'cursor-pointer hover:border-accent/50 hover:bg-surface/80 transition-all' : ''
      }`}
      onClick={onClick}
    >
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: accent ? `${accent}15` : '#00BCD415', color: accent ?? '#00BCD4' }}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {loading ? (
            <div className="h-7 w-12 bg-border rounded animate-pulse-slow" />
          ) : (
            <div className="text-2xl font-bold text-text-primary tabular-nums">{value}</div>
          )}
          {sparklineData && sparklineData.length >= 2 && (
            <SparklineKPI data={sparklineData} invertTrend={invertTrend} />
          )}
        </div>
        <div className="text-xs text-text-secondary leading-tight">{label}</div>
        {subtitle && <div className="text-xs text-text-secondary/80 leading-tight mt-0.5">{subtitle}</div>}
      </div>
    </div>
  )
}

/* ── Main KPICards component ────────────────────────────────── */

interface KPICardsProps {
  kpis: KPIs | null
  cases: SupportCase[]
  accounts: AccountInfo[]
  techWinsNeeded: PipelineOpp[]
  loading: boolean
  rhLastScraped?: string | null
  rhHasSession?: boolean
  sparklineHistory?: Record<string, number[]>
}

function rhTimeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function KPICards({ kpis, cases, accounts, techWinsNeeded, loading, rhLastScraped, rhHasSession, sparklineHistory }: KPICardsProps) {
  const [casesOpen, setCasesOpen] = useState(false)
  const [sev1Open, setSev1Open] = useState(false)
  const [redOpen, setRedOpen] = useState(false)
  const [amberOpen, setAmberOpen] = useState(false)
  const [techWinsOpen, setTechWinsOpen] = useState(false)

  // KPI config persistence (BKL-UX45)
  const [kpiConfig, setKpiConfig] = useState<KPIConfig>(loadKPIConfig)

  const updateKpiConfig = useCallback((updater: (prev: KPIConfig) => KPIConfig) => {
    setKpiConfig((prev) => {
      const next = updater(prev)
      saveKPIConfig(next)
      return next
    })
  }, [])

  // Ensure new KPI IDs added later get appended to order
  useEffect(() => {
    const missing = DEFAULT_KPI_IDS.filter((id) => !kpiConfig.order.includes(id))
    if (missing.length > 0) {
      updateKpiConfig((prev) => ({
        ...prev,
        order: [...prev.order, ...missing],
      }))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Build sorted renewal rows from accounts
  const renewalRows = useMemo((): RenewalRow[] => {
    const today = Date.now()
    const rows: RenewalRow[] = []
    for (const acct of accounts) {
      for (const p of acct.products ?? []) {
        if (!p.endDate) continue
        const daysLeft = Math.ceil((new Date(p.endDate).getTime() - today) / 86_400_000)
        if (daysLeft <= 90) {
          rows.push({
            customerName: acct.name,
            productDescription: p.productDescription,
            quantity: p.quantity,
            endDate: p.endDate,
            daysLeft,
            ae: acct.ae,
          })
        }
      }
    }
    return rows.sort((a, b) => a.daysLeft - b.daysLeft)
  }, [accounts])

  const redRows = renewalRows.filter((r) => r.daysLeft < 30)
  const amberRows = renewalRows.filter((r) => r.daysLeft >= 30)
  const redCount = redRows.length
  const amberCount = amberRows.length

  const redByCustomer = useMemo(() => {
    const map = new Map<string, RenewalRow[]>()
    for (const row of redRows) {
      const list = map.get(row.customerName) ?? []
      list.push(row)
      map.set(row.customerName, list)
    }
    return Array.from(map.entries()).sort((a, b) => a[1][0].daysLeft - b[1][0].daysLeft)
  }, [redRows])

  const amberByCustomer = useMemo(() => {
    const map = new Map<string, RenewalRow[]>()
    for (const row of amberRows) {
      const list = map.get(row.customerName) ?? []
      list.push(row)
      map.set(row.customerName, list)
    }
    return Array.from(map.entries()).sort((a, b) => a[1][0].daysLeft - b[1][0].daysLeft)
  }, [amberRows])

  // KPI card definitions keyed by ID
  const kpiCards: Record<string, React.ReactNode> = {
    openCases: (
      <KPICard
        key="openCases"
        label="Open Cases"
        value={kpis?.openCasesTotal ?? 0}
        icon={<ShieldAlert className="w-5 h-5" />}
        accent="#00BCD4"
        loading={loading}
        onClick={() => setCasesOpen(true)}
        sparklineData={sparklineHistory?.openCases}
        invertTrend
        subtitle={
          rhHasSession === false
            ? 'No RH session'
            : rhLastScraped
            ? `Synced ${rhTimeAgo(rhLastScraped)}`
            : undefined
        }
      />
    ),
    sev1Cases: (
      <KPICard
        key="sev1Cases"
        label="Sev 1 Cases"
        value={kpis?.sev1Count ?? 0}
        icon={<AlertTriangle className="w-5 h-5" />}
        accent="#F85149"
        loading={loading}
        onClick={() => setSev1Open(true)}
        sparklineData={sparklineHistory?.sev1Cases}
        invertTrend
      />
    ),
    meetingsToday: (
      <KPICard
        key="meetingsToday"
        label="Meetings Today"
        value={kpis?.meetingsToday ?? 0}
        icon={<CalendarCheck className="w-5 h-5" />}
        accent="#00BCD4"
        loading={loading}
        onClick={() => {
          const el = document.getElementById('section-calendar')
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }}
        sparklineData={sparklineHistory?.meetingsToday}
      />
    ),
    meetingsThisWeek: (
      <KPICard
        key="meetingsThisWeek"
        label="Meetings This Week"
        value={kpis?.meetingsThisWeek ?? 0}
        icon={<CalendarDays className="w-5 h-5" />}
        accent="#00BCD4"
        loading={loading}
        onClick={() => {
          const el = document.getElementById('section-calendar')
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }}
        sparklineData={sparklineHistory?.meetingsThisWeek}
      />
    ),
    expiringWithin30: (
      <KPICard
        key="expiringWithin30"
        label="Expiring Within 30 Days"
        value={loading ? 0 : redCount}
        icon={<Package className="w-5 h-5" />}
        accent={redCount > 0 ? '#F85149' : '#3FB950'}
        loading={loading}
        onClick={redCount > 0 ? () => setRedOpen(true) : undefined}
        sparklineData={sparklineHistory?.expiringWithin30}
        invertTrend
      />
    ),
    renewals30to90: (
      <KPICard
        key="renewals30to90"
        label="Renewals in 30-90 Days"
        value={loading ? 0 : amberCount}
        icon={<Key className="w-5 h-5" />}
        accent={amberCount > 0 ? '#D29922' : '#3FB950'}
        loading={loading}
        onClick={amberCount > 0 ? () => setAmberOpen(true) : undefined}
        sparklineData={sparklineHistory?.renewals30to90}
      />
    ),
    techWinsNeeded: (
      <KPICard
        key="techWinsNeeded"
        label="Tech Wins Needed"
        value={loading ? 0 : techWinsNeeded.length}
        icon={<Trophy className="w-5 h-5" />}
        accent={techWinsNeeded.length > 0 ? '#D29922' : '#3FB950'}
        loading={loading}
        onClick={techWinsNeeded.length > 0 ? () => setTechWinsOpen(true) : undefined}
        sparklineData={sparklineHistory?.techWinsNeeded}
      />
    ),
  }

  // Render cards in persisted order, filtering hidden
  const visibleCards = kpiConfig.order
    .filter((id) => !kpiConfig.hidden.includes(id) && kpiCards[id])
    .map((id) => kpiCards[id])

  return (
    <>
      {/* BKL-UX44: Flex-wrap container for graceful wrapping at any KPI count */}
      <div className="flex flex-wrap gap-3">
        {visibleCards}
      </div>

      {/* Hint when RH Portal not connected */}
      {rhHasSession === false && (kpis?.openCasesTotal ?? 0) === 0 && (
        <p className="text-xs text-text-secondary/50 mt-1 ml-1">Connect Red Hat Portal in Settings to sync support cases</p>
      )}

      {/* Extracted modal components (BKL-UX46) */}
      <KPICasesModal open={casesOpen} onClose={() => setCasesOpen(false)} cases={cases} />
      <KPISev1Modal open={sev1Open} onClose={() => setSev1Open(false)} cases={cases} />

      {redOpen && (
        <KPIRenewalsModal
          title="Expiring Within 30 Days"
          accentClass="text-critical"
          rows={redRows}
          byCustomer={redByCustomer}
          onClose={() => setRedOpen(false)}
        />
      )}

      {amberOpen && (
        <KPIRenewalsModal
          title="Renewals in 30-90 Days"
          accentClass="text-warning"
          rows={amberRows}
          byCustomer={amberByCustomer}
          onClose={() => setAmberOpen(false)}
        />
      )}

      <KPITechWinsModal open={techWinsOpen} onClose={() => setTechWinsOpen(false)} opps={techWinsNeeded} />
    </>
  )
}
