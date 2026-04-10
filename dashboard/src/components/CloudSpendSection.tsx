import { useState } from 'react'
import type { CCSPSummary, CCSPByAE } from '../types'
import { fmtCurrency as fmt } from '../lib/format'
import RelTime from './RelTime'
import { Cloud, Building2, RefreshCw, AlertCircle, Users } from 'lucide-react'
import { Link } from 'react-router-dom'


function shortName(name: string): string {
  return name
    .replace(/, (INC\.|LLC|INC|CORP|LTD|LP)\.?$/i, '')
    .replace(/ (Inc\.|LLC|Inc|Corp|Ltd|LP|Co\.)\.?$/i, '')
    .replace(/ U\.S\.,?.*$/i, '')
    .trim()
}

const ACCOUNT_COLORS = [
  '#00BCD4', '#FF9900', '#4285F4', '#F85149', '#3FB950',
  '#D29922', '#A371F7', '#FF7B72', '#56D364', '#FFA657',
  '#79C0FF', '#E3B341', '#FF6BD6', '#7EE787', '#58A6FF',
]

const PARTNER_COLORS: Record<string, string> = {
  AWS:       '#FF9900',
  Google:    '#4285F4',
  Microsoft: '#00A4EF',
  Other:     '#6B7280',
}

// Derive all unique quarters across all AEs, sorted chronologically
function allAEQuarters(byAE: CCSPByAE[]): string[] {
  const set = new Set<string>()
  for (const ae of byAE) {
    for (const q of ae.byQuarter) {
      set.add(q.quarter)
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}

function fmtQuarterLabel(q: string, totalQuarters: number): string {
  const [year, quarter] = q.replace('-Q', ' Q').split(' ')
  return totalQuarters >= 4 ? `${quarter} '${year.slice(2)}` : `${year} ${quarter}`
}

interface ByAETileProps {
  data: CCSPSummary | null
  loading: boolean
  activeAE: string | null
  onSelectAE: (ae: string | null) => void
}

function ByAETile({ data, loading, activeAE, onSelectAE }: ByAETileProps) {
  const byAE = data?.byAE ?? []
  const totalSpend = byAE.reduce((sum, a) => sum + a.acv, 0)
  const maxAEAcv = byAE.reduce((m, a) => Math.max(m, a.acv), 0)
  const quarters = byAE.length > 0 ? allAEQuarters(byAE) : []

  // Dynamic grid columns: 1 label col + N quarter cols
  // We use a CSS grid with inline style to handle variable quarter count
  const gridCols = `5rem repeat(${quarters.length}, minmax(0, 1fr))`

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Users className="w-3.5 h-3.5 text-accent" />
        <span className="text-sm font-semibold text-text-secondary">By AE</span>
        {activeAE && (
          <button
            onClick={() => onSelectAE(null)}
            className="ml-auto text-xs text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Clear AE filter"
          >
            clear
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-8 bg-border rounded animate-pulse-slow" />)}
        </div>
      ) : byAE.length === 0 ? (
        <div className="text-xs text-text-secondary">No AE data</div>
      ) : (
        <>
          {/* Per-AE rows with progress bars */}
          <div className="space-y-2">
            {byAE.map(({ ae, acv, topAccounts }) => {
              const pct = maxAEAcv > 0 ? (acv / maxAEAcv) * 100 : 0
              const customerCount = topAccounts?.length ?? 0
              const isActive = activeAE === ae
              return (
                <button
                  key={ae}
                  onClick={() => onSelectAE(isActive ? null : ae)}
                  className={`w-full text-left rounded px-2 py-1 transition-colors ${isActive ? 'bg-border/40' : 'hover:bg-border/20'}`}
                >
                  <div className="flex justify-between text-sm mb-1 min-w-0">
                    <span className={`font-medium truncate min-w-0 ${isActive ? 'text-text-primary' : 'text-text-secondary'}`} title={ae}>
                      {ae.split(' ')[0]}
                    </span>
                    <span className="text-xs text-text-secondary shrink-0 ml-2 tabular-nums">
                      {fmt(acv)}{customerCount > 0 ? ` · ${customerCount}` : ''}
                    </span>
                  </div>
                  <div className="h-1.5 bg-border rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: isActive ? '#58A6FF' : '#4B5563' }}
                    />
                  </div>
                </button>
              )
            })}
          </div>

          {/* Quarter x AE grid */}
          {quarters.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border/50">
              {/* Column headers */}
              <div
                className="gap-x-2 pb-1 mb-0 border-b border-border/40"
                style={{ display: 'grid', gridTemplateColumns: gridCols }}
              >
                <span className="text-xs text-text-secondary w-20 min-w-[5rem]"></span>
                {quarters.map(q => (
                  <span key={q} className="text-xs font-medium text-text-secondary text-right truncate min-w-0">
                    {fmtQuarterLabel(q, quarters.length)}
                  </span>
                ))}
              </div>
              {/* AE rows */}
              {byAE.map(({ ae, byQuarter }) => {
                const qMap = new Map(byQuarter.map(q => [q.quarter, q.acv]))
                const isActive = activeAE === ae
                return (
                  <div
                    key={ae}
                    className={`gap-x-2 py-1 rounded px-1 -mx-1 border-b border-border/10 ${isActive ? 'bg-border/30' : 'hover:bg-border/20'}`}
                    style={{ display: 'grid', gridTemplateColumns: gridCols }}
                  >
                    <span className={`text-xs font-medium truncate min-w-0 w-20 ${isActive ? 'text-text-primary' : 'text-text-secondary'}`}>
                      {ae.split(' ')[0]}
                    </span>
                    {quarters.map(q => {
                      const acv = qMap.get(q) ?? 0
                      return (
                        <span key={q} className="text-xs text-text-primary text-right tabular-nums font-mono">
                          {acv > 0 ? fmt(acv) : <span className="text-text-secondary/65">—</span>}
                        </span>
                      )
                    })}
                  </div>
                )
              })}
              {/* Total row */}
              {byAE.length >= 1 && (
                <div
                  className="gap-x-2 py-1 border-t border-border/40 mt-0 pt-1 px-1 -mx-1"
                  style={{ display: 'grid', gridTemplateColumns: gridCols }}
                >
                  <span className="text-xs font-medium text-text-secondary w-20">Total</span>
                  {quarters.map(q => {
                    const total = byAE.reduce((sum, ae) => {
                      const qMap = new Map(ae.byQuarter.map(qd => [qd.quarter, qd.acv]))
                      return sum + (qMap.get(q) ?? 0)
                    }, 0)
                    return (
                      <span key={q} className="text-xs text-text-primary text-right tabular-nums font-mono font-medium">
                        {total > 0 ? fmt(total) : <span className="text-text-secondary/65">—</span>}
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
          )}

        </>
      )}
    </div>
  )
}

interface Props {
  data: CCSPSummary | null
  loading: boolean
  error?: string | null
  onRefresh?: () => void
}

export function CloudSpendSection({ data, loading, error, onRefresh }: Props) {
  const [activeAE, setActiveAE] = useState<string | null>(null)

  const customers = data?.byCustomer ?? []
  const partners = data?.byPartner ?? []
  const totalAcv = data?.totalAcv ?? 0

  // BKL-G17: reporting period range badge (e.g. "2025 Q3–Q4")
  // Data format: "2025-Q3" (YYYY-QN) — fixed from prior CY25Q1 assumption (BKL-W3-01)
  const QTR_FMT = /^\d{4}-Q\d$/
  const allQuarters = data?.byQuarter ?? []
  const reportingPeriod = allQuarters.length > 0 ? (() => {
    const validQ = allQuarters.filter(q => QTR_FMT.test(q.quarter))
    if (!validQ.length) return null
    const sorted = [...validQ].sort((a, b) => a.quarter.localeCompare(b.quarter))
    const first = sorted[0].quarter   // e.g. "2025-Q3"
    const last  = sorted[sorted.length - 1].quarter
    const fy1 = first.slice(0, 4)   // "2025"
    const q1  = first.slice(5)       // "Q3"
    const fy2 = last.slice(0, 4)
    const q2  = last.slice(5)
    if (first === last) return `${fy1} ${q1}`
    return fy1 === fy2 ? `${fy1} ${q1}–${q2}` : `${fy1} ${q1} – ${fy2} ${q2}`
  })() : null

  // Top accounts: filter by selected AE
  const activeAEData = activeAE ? data?.byAE?.find(a => a.ae === activeAE) : null
  const displayedAccounts = activeAE
    ? (activeAEData?.topAccounts ?? [])
    : customers.slice(0, 10).map(c => ({ name: c.name, acv: c.acv }))

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Section header */}
      <div className="px-5 py-3.5 border-b border-border flex items-center gap-2">
        <Cloud className="w-4 h-4 text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Cloud Spend (CCSP)</h2>
        {reportingPeriod ? (
          <span className="text-xs font-medium text-accent bg-accent/10 border border-accent/20 rounded-full px-2 py-0.5">{reportingPeriod}</span>
        ) : (
          <span className="text-xs text-text-secondary">Marketplace Revenue</span>
        )}
        {data?.sourceWarning && !loading && (
          <span className="text-xs text-warning flex items-center gap-1">
            <AlertCircle className="w-3 h-3" /> stale data
          </span>
        )}
        {loading && <span className="text-xs text-text-secondary animate-pulse">Loading…</span>}
        {!loading && (
          <span className="text-xs text-text-secondary ml-auto flex items-center gap-2">
            {data?.cachedAt ? <RelTime iso={data.cachedAt} className="text-xs text-text-secondary" /> : 'Live'}
            {onRefresh && (
              <button onClick={onRefresh} className="text-text-secondary hover:text-text-primary transition-colors" title="Refresh" aria-label="Refresh cloud spend data">
                <RefreshCw className="w-3 h-3" />
              </button>
            )}
          </span>
        )}
      </div>

      {/* Error state */}
      {error && !loading && (
        <div className="flex items-center gap-2 text-xs text-critical bg-critical/10 border border-critical/20 rounded-lg mx-5 mt-4 px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Failed to load cloud spend data. {onRefresh && <button onClick={onRefresh} className="underline hover:no-underline">Retry</button>}</span>
        </div>
      )}

      {/* Empty state — not loading, no error, but no data yet */}
      {!loading && !error && !data && (
        <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
          <Cloud className="w-8 h-8 text-text-secondary opacity-40" />
          <p className="text-sm text-text-secondary">No cloud spend data available</p>
          <p className="text-xs text-text-secondary max-w-sm">
            Run a CCSP sync from <Link to="/dashboard/setup" className="text-accent hover:underline">Admin &gt; Data Sources</Link> to populate cloud marketplace revenue data.
          </p>
          <p className="text-xs text-text-secondary/60 mt-1">CCSP (Cloud &amp; Service Provider) tracks AWS, Azure, and GCP marketplace spend across your accounts.</p>
        </div>
      )}

      <div className="p-5 grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Left: Total + Partner breakdown */}
        <div className="bg-surface border border-border rounded-xl p-4 flex flex-col gap-4">
          <div>
            <div className="text-xs text-text-secondary mb-1">Total Portfolio ACV</div>
            {loading ? (
              <div className="h-8 w-28 bg-border rounded animate-pulse-slow" />
            ) : (
              <div className="text-3xl font-bold text-text-primary tabular-nums">{fmt(totalAcv)}</div>
            )}
            <div className="text-xs text-text-secondary">{customers.length} accounts</div>
          </div>

          <div>
            <div className="text-xs font-medium text-text-secondary mb-2">By Cloud Partner</div>
            <div className="space-y-2">
              {loading
                ? [1, 2, 3].map((i) => <div key={i} className="h-5 bg-border rounded animate-pulse-slow" />)
                : partners.map(({ partner, acv }) => {
                  const pct = totalAcv > 0 ? (acv / totalAcv) * 100 : 0
                  const color = PARTNER_COLORS[partner] ?? PARTNER_COLORS.Other
                  return (
                    <div key={partner}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-text-primary font-medium">{partner}</span>
                        <span className="text-text-secondary">{fmt(acv)} · {(pct ?? 0).toFixed(0)}%</span>
                      </div>
                      <div className="h-1.5 bg-border rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
                      </div>
                    </div>
                  )
                })
              }
            </div>
          </div>
        </div>

        {/* Middle: By AE — mirrors Pipeline "By Owner" layout */}
        <ByAETile
          data={data}
          loading={loading}
          activeAE={activeAE}
          onSelectAE={setActiveAE}
        />

        {/* Right: Top accounts (filtered by AE when selected) */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Building2 className="w-3.5 h-3.5 text-accent" />
            <span className="text-sm font-medium text-text-secondary">
              Top Accounts{activeAE ? ` (${activeAE.split(' ')[0]})` : ''}
            </span>
          </div>
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-5 bg-border rounded animate-pulse-slow" />)}
            </div>
          ) : displayedAccounts.length === 0 ? (
            <div className="text-xs text-text-secondary">No data</div>
          ) : (
            <div className="space-y-2">
              {displayedAccounts.map(({ name, acv }, i) => {
                const maxAcv = displayedAccounts[0]?.acv || 1
                const pct = maxAcv > 0 ? ((acv ?? 0) / maxAcv) * 100 : 0
                const color = ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]
                return (
                  <div key={name}>
                    <div className="flex items-center justify-between text-sm mb-0.5 min-w-0">
                      <Link
                        to={`/dashboard/customer/${encodeURIComponent(shortName(name))}`}
                        className="text-text-primary truncate flex-1 min-w-0 mr-2 hover:underline"
                        title={shortName(name)}
                      >
                        {i + 1}. {shortName(name)}
                      </Link>
                      <span className="text-xs text-text-secondary shrink-0 font-mono">{fmt(acv)}</span>
                    </div>
                    <div className="h-1 bg-border rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
