import { useState, useMemo } from 'react'
import { fmtCurrency as fmtAcv } from '../lib/format'
import type { KPIs, SupportCase, AccountInfo, PipelineOpp } from '../types'
import { SupportCasesTable } from './SupportCasesTable'
import {
  ShieldAlert,
  AlertTriangle,
  CalendarCheck,
  CalendarDays,
  Package,
  Key,
  X,
  ArrowRight,
  Trophy,
  ExternalLink,
} from 'lucide-react'

interface KPICardProps {
  label: string
  value: number | string
  icon: React.ReactNode
  accent?: string
  loading?: boolean
  onClick?: () => void
  subtitle?: React.ReactNode
}

function KPICard({ label, value, icon, accent, loading, onClick, subtitle }: KPICardProps) {
  return (
    <div
      className={`bg-surface border border-border rounded-xl p-4 flex items-center gap-4 ${
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
      <div className="min-w-0">
        {loading ? (
          <div className="h-7 w-12 bg-border rounded animate-pulse-slow" />
        ) : (
          <div className="text-2xl font-bold text-text-primary">{value}</div>
        )}
        <div className="text-xs text-text-secondary leading-tight">{label}</div>
        {subtitle && <div className="text-xs text-text-secondary/80 leading-tight mt-0.5">{subtitle}</div>}
      </div>
    </div>
  )
}

interface RenewalRow {
  customerName: string
  productDescription: string
  quantity: number
  endDate: string
  daysLeft: number
}

function urgencyColor(daysLeft: number): string {
  if (daysLeft < 0)  return 'text-critical'
  if (daysLeft < 30) return 'text-critical'
  if (daysLeft < 60) return 'text-warning'
  return 'text-yellow-400'
}

function urgencyBg(daysLeft: number): string {
  if (daysLeft < 0)  return 'bg-critical/10 border-critical/20'
  if (daysLeft < 30) return 'bg-critical/10 border-critical/20'
  if (daysLeft < 60) return 'bg-warning/10 border-warning/20'
  return 'bg-yellow-500/10 border-yellow-500/20'
}

function daysLabel(daysLeft: number): string {
  if (daysLeft < 0)  return `${Math.abs(daysLeft)}d expired`
  if (daysLeft === 0) return 'expires today'
  return `${daysLeft}d left`
}

function RenewalsModal({ title, accentClass, rows, byCustomer, onClose }: {
  title: string
  accentClass: string
  rows: RenewalRow[]
  byCustomer: [string, RenewalRow[]][]
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl w-full max-w-3xl max-h-[82vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Package className={`w-4 h-4 ${accentClass}`} />
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            <span className="text-xs text-text-secondary">{rows.length} subscriptions · {byCustomer.length} accounts</span>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 divide-y divide-border/50">
          {byCustomer.map(([customerName, custRows]) => (
            <div key={customerName} className="px-5 py-3.5">
              <div className="flex items-center justify-between mb-2">
                <a
                  href={`/dashboard/customer/${encodeURIComponent(customerName)}`}
                  className="flex items-center gap-1.5 text-sm font-semibold text-text-primary hover:text-accent transition-colors"
                  onClick={onClose}
                >
                  {customerName}
                  <ArrowRight className="w-3.5 h-3.5" />
                </a>
                <span className="text-xs text-text-secondary">{custRows.length} item{custRows.length > 1 ? 's' : ''}</span>
              </div>
              <div className="space-y-1.5">
                {custRows.map((row, i) => (
                  <div key={i} className={`flex items-center justify-between gap-3 text-xs px-3 py-2 rounded-lg border ${urgencyBg(row.daysLeft)}`}>
                    <span className="text-text-primary truncate flex-1">{row.productDescription}</span>
                    <span className="text-text-secondary shrink-0">×{row.quantity}</span>
                    <span className={`font-mono font-semibold shrink-0 ${urgencyColor(row.daysLeft)}`}>
                      {daysLabel(row.daysLeft)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}


function fmtDateShort(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const TW_STAGE_COLORS: Record<string, string> = {
  Commit: '#3FB950', 'Best Case': '#D29922', Pipeline: '#58A6FF', Omitted: '#6B7280',
}

function twUrgencyClass(iso: string): string {
  if (!iso) return 'text-text-secondary'
  const days = (new Date(iso).getTime() - Date.now()) / 86_400_000
  if (days < 0)   return 'text-critical'
  if (days <= 30) return 'text-warning'
  if (days <= 90) return 'text-accent'
  return 'text-text-secondary'
}

interface KPICardsProps {
  kpis: KPIs | null
  cases: SupportCase[]
  accounts: AccountInfo[]
  techWinsNeeded: PipelineOpp[]
  loading: boolean
  rhLastScraped?: string | null
  rhHasSession?: boolean
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

export function KPICards({ kpis, cases, accounts, techWinsNeeded, loading, rhLastScraped, rhHasSession }: KPICardsProps) {
  const [casesOpen, setCasesOpen] = useState(false)
  const [sev1Open, setSev1Open] = useState(false)
  const [redOpen, setRedOpen] = useState(false)
  const [amberOpen, setAmberOpen] = useState(false)
  const [techWinsOpen, setTechWinsOpen] = useState(false)
  const [twSortBy, setTwSortBy] = useState<'acv' | 'date' | 'stage'>('acv')

  // Build sorted renewal rows from accounts
  const renewalRows = useMemo((): RenewalRow[] => {
    const today = Date.now()
    const rows: RenewalRow[] = []
    for (const acct of accounts) {
      for (const p of acct.products ?? []) {
        if (!p.endDate) continue
        const daysLeft = Math.ceil((new Date(p.endDate).getTime() - today) / 86_400_000)
        if (daysLeft <= 90) {
          rows.push({ customerName: acct.name, productDescription: p.productDescription, quantity: p.quantity, endDate: p.endDate, daysLeft })
        }
      }
    }
    return rows.sort((a, b) => a.daysLeft - b.daysLeft)
  }, [accounts])

  const redRows   = renewalRows.filter((r) => r.daysLeft < 30)   // expired + <30d
  const amberRows = renewalRows.filter((r) => r.daysLeft >= 30)  // 30–90d
  const redCount   = redRows.length
  const amberCount = amberRows.length

  const redByCustomer = useMemo(() => {
    const map = new Map<string, RenewalRow[]>()
    for (const row of redRows) {
      const list = map.get(row.customerName) ?? []; list.push(row); map.set(row.customerName, list)
    }
    return Array.from(map.entries()).sort((a, b) => a[1][0].daysLeft - b[1][0].daysLeft)
  }, [redRows])

  const amberByCustomer = useMemo(() => {
    const map = new Map<string, RenewalRow[]>()
    for (const row of amberRows) {
      const list = map.get(row.customerName) ?? []; list.push(row); map.set(row.customerName, list)
    }
    return Array.from(map.entries()).sort((a, b) => a[1][0].daysLeft - b[1][0].daysLeft)
  }, [amberRows])

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
        <KPICard
          label="Open Cases"
          value={kpis?.openCasesTotal ?? 0}
          icon={<ShieldAlert className="w-5 h-5" />}
          accent="#00BCD4"
          loading={loading}
          onClick={() => setCasesOpen(true)}
          subtitle={
            rhHasSession === false
              ? 'No RH session'
              : rhLastScraped
              ? `Synced ${rhTimeAgo(rhLastScraped)}`
              : undefined
          }
        />
        <KPICard
          label="Sev 1 Cases"
          value={kpis?.sev1Count ?? 0}
          icon={<AlertTriangle className="w-5 h-5" />}
          accent="#F85149"
          loading={loading}
          onClick={() => setSev1Open(true)}
        />
        <KPICard
          label="Meetings Today"
          value={kpis?.meetingsToday ?? 0}
          icon={<CalendarCheck className="w-5 h-5" />}
          accent="#00BCD4"
          loading={loading}
        />
        <KPICard
          label="Meetings This Week"
          value={kpis?.meetingsThisWeek ?? 0}
          icon={<CalendarDays className="w-5 h-5" />}
          accent="#00BCD4"
          loading={loading}
        />
        <KPICard
          label="Expiring Within 30 Days"
          value={loading ? 0 : redCount}
          icon={<Package className="w-5 h-5" />}
          accent={redCount > 0 ? '#F85149' : '#3FB950'}
          loading={loading}
          onClick={redCount > 0 ? () => setRedOpen(true) : undefined}
        />
        <KPICard
          label="Renewals in 30–90 Days"
          value={loading ? 0 : amberCount}
          icon={<Key className="w-5 h-5" />}
          accent={amberCount > 0 ? '#D29922' : '#3FB950'}
          loading={loading}
          onClick={amberCount > 0 ? () => setAmberOpen(true) : undefined}
        />
        <KPICard
          label="Tech Wins Needed"
          value={loading ? 0 : techWinsNeeded.length}
          icon={<Trophy className="w-5 h-5" />}
          accent={techWinsNeeded.length > 0 ? '#D29922' : '#3FB950'}
          loading={loading}
          onClick={techWinsNeeded.length > 0 ? () => setTechWinsOpen(true) : undefined}
        />
      </div>

      {/* Hint when RH Portal not connected */}
      {rhHasSession === false && (kpis?.openCasesTotal ?? 0) === 0 && (
        <p className="text-xs text-text-secondary/50 mt-1 ml-1">Connect Red Hat Portal in Settings to sync support cases</p>
      )}

      {/* Cases modal */}
      {casesOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setCasesOpen(false)}>
          <div className="bg-surface border border-border rounded-2xl w-full max-w-4xl max-h-[80vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-text-primary">Open Support Cases</h2>
                <span className="text-xs text-text-secondary">{cases.length} open</span>
              </div>
              <button onClick={() => setCasesOpen(false)} className="text-text-secondary hover:text-text-primary transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              <SupportCasesTable cases={cases} loading={false} />
            </div>
          </div>
        </div>
      )}

      {/* Sev 1 cases modal */}
      {sev1Open && (() => {
        const sev1Cases = cases.filter((c) => String(c.severity) === '1')
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setSev1Open(false)}>
            <div className="bg-surface border border-border rounded-2xl w-full max-w-4xl max-h-[80vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-critical" />
                  <h2 className="text-sm font-semibold text-text-primary">Severity 1 Cases</h2>
                  <span className="text-xs text-text-secondary">{sev1Cases.length} open</span>
                </div>
                <button onClick={() => setSev1Open(false)} className="text-text-secondary hover:text-text-primary transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="overflow-y-auto flex-1">
                <SupportCasesTable cases={sev1Cases} loading={false} />
              </div>
            </div>
          </div>
        )
      })()}

      {/* Red renewals modal — expired + <30d */}
      {redOpen && (
        <RenewalsModal
          title="Expiring Within 30 Days"
          accentClass="text-critical"
          rows={redRows}
          byCustomer={redByCustomer}
          onClose={() => setRedOpen(false)}
        />
      )}

      {/* Amber renewals modal — 30–90d */}
      {amberOpen && (
        <RenewalsModal
          title="Renewals in 30–90 Days"
          accentClass="text-warning"
          rows={amberRows}
          byCustomer={amberByCustomer}
          onClose={() => setAmberOpen(false)}
        />
      )}

      {/* Tech Wins Needed modal */}
      {techWinsOpen && (() => {
        const TW_STAGE_SORT: Record<string, number> = { Commit: 0, 'Best Case': 1, Pipeline: 2, Omitted: 3 }
        const sorted = [...techWinsNeeded].sort((a, b) => {
          if (twSortBy === 'date')  return (a.closeDate ?? '').localeCompare(b.closeDate ?? '')
          if (twSortBy === 'stage') return (TW_STAGE_SORT[a.forecastCategory] ?? 9) - (TW_STAGE_SORT[b.forecastCategory] ?? 9)
          return b.acv - a.acv
        })
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setTechWinsOpen(false)}>
            <div className="bg-surface border border-border rounded-2xl w-full max-w-xl max-h-[80vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="px-5 py-4 border-b border-border flex items-center gap-2 shrink-0">
                <Trophy className="w-4 h-4 text-warning shrink-0" />
                <h2 className="text-sm font-semibold text-text-primary">Tech Wins Needed</h2>
                <span className="text-xs text-text-secondary">
                  {techWinsNeeded.length} opps · {fmtAcv(techWinsNeeded.reduce((s, o) => s + o.acv, 0))} at stake
                </span>
                <div className="ml-auto flex items-center gap-0.5 bg-border/30 rounded-md p-0.5">
                  {(['acv', 'date', 'stage'] as const).map(opt => (
                    <button
                      key={opt}
                      onClick={() => setTwSortBy(opt)}
                      className={`text-xs px-1.5 py-0.5 rounded transition-colors ${twSortBy === opt ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
                    >
                      {opt === 'acv' ? '$' : opt === 'date' ? 'Date' : 'Stage'}
                    </button>
                  ))}
                </div>
                <button onClick={() => setTechWinsOpen(false)} className="text-text-secondary hover:text-text-primary transition-colors ml-1">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="overflow-y-auto flex-1 divide-y divide-border/50">
                {sorted.map(opp => {
                  const stageColor = TW_STAGE_COLORS[opp.forecastCategory] ?? TW_STAGE_COLORS.Omitted
                  const stageLabel = opp.forecastCategory === 'Best Case' ? 'Best' : opp.forecastCategory
                  const sfUrl = `https://redhatcrm.lightning.force.com/_ui/search/ui/UnifiedSearchResults?str=${encodeURIComponent(opp.oppNumber)}`
                  return (
                    <a
                      key={opp.oppNumber}
                      href={sfUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="px-5 py-3.5 flex items-center gap-3 hover:bg-accent/10 cursor-pointer group"
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: stageColor }} />
                      <span className="text-xs font-semibold w-12 shrink-0" style={{ color: stageColor }}>{stageLabel}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-text-secondary truncate">{opp.accountName}</p>
                        <p className="text-xs font-medium text-text-primary truncate leading-snug group-hover:text-accent transition-colors">{opp.oppName}</p>
                      </div>
                      <div className="text-right shrink-0 ml-2">
                        <p className="text-xs font-mono font-semibold text-text-primary">{fmtAcv(opp.acv)}</p>
                        <p className={`text-xs ${twUrgencyClass(opp.closeDate)}`}>{fmtDateShort(opp.closeDate)}</p>
                      </div>
                      <ExternalLink className="w-3.5 h-3.5 text-text-secondary/65 group-hover:text-accent transition-colors shrink-0" />
                    </a>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })()}
    </>
  )
}
