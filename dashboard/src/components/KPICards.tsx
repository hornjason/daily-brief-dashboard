import { useState, useMemo } from 'react'
import type { KPIs, SupportCase, AccountInfo } from '../types'
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
} from 'lucide-react'

interface KPICardProps {
  label: string
  value: number | string
  icon: React.ReactNode
  accent?: string
  loading?: boolean
  onClick?: () => void
}

function KPICard({ label, value, icon, accent, loading, onClick }: KPICardProps) {
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

interface KPICardsProps {
  kpis: KPIs | null
  cases: SupportCase[]
  accounts: AccountInfo[]
  loading: boolean
}

export function KPICards({ kpis, cases, accounts, loading }: KPICardsProps) {
  const [casesOpen, setCasesOpen] = useState(false)
  const [redOpen, setRedOpen] = useState(false)
  const [amberOpen, setAmberOpen] = useState(false)

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
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <KPICard
          label="Open Cases"
          value={kpis?.openCasesTotal ?? 0}
          icon={<ShieldAlert className="w-5 h-5" />}
          accent="#00BCD4"
          loading={loading}
          onClick={() => setCasesOpen(true)}
        />
        <KPICard
          label="Sev 1 Cases"
          value={kpis?.sev1Count ?? 0}
          icon={<AlertTriangle className="w-5 h-5" />}
          accent="#F85149"
          loading={loading}
          onClick={() => setCasesOpen(true)}
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
      </div>

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
    </>
  )
}
