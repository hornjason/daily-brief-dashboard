import type { KPIs } from '../types'
import {
  ShieldAlert,
  AlertTriangle,
  CalendarCheck,
  CalendarDays,
  Package,
  Key,
} from 'lucide-react'

interface KPICardProps {
  label: string
  value: number | string
  icon: React.ReactNode
  accent?: string
  loading?: boolean
}

function KPICard({ label, value, icon, accent, loading }: KPICardProps) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 flex items-center gap-4">
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
        <div className="text-xs text-text-secondary truncate">{label}</div>
      </div>
    </div>
  )
}

interface KPICardsProps {
  kpis: KPIs | null
  loading: boolean
}

export function KPICards({ kpis, loading }: KPICardsProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      <KPICard
        label="Open Cases"
        value={kpis?.openCasesTotal ?? 0}
        icon={<ShieldAlert className="w-5 h-5" />}
        accent="#00BCD4"
        loading={loading}
      />
      <KPICard
        label="Sev 1 Cases"
        value={kpis?.sev1Count ?? 0}
        icon={<AlertTriangle className="w-5 h-5" />}
        accent="#F85149"
        loading={loading}
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
        label="Products Owned"
        value={kpis?.totalProducts ?? 0}
        icon={<Package className="w-5 h-5" />}
        accent="#3FB950"
        loading={loading}
      />
      <KPICard
        label="Total Licenses"
        value={kpis?.totalLicenses ?? 0}
        icon={<Key className="w-5 h-5" />}
        accent="#D29922"
        loading={loading}
      />
    </div>
  )
}
