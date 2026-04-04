import { useState } from 'react'
import type { CCSPSummary } from '../types'
import { fmtCurrency as fmt } from '../lib/format'
import RelTime from './RelTime'
import { Cloud, Building2, RefreshCw, AlertCircle, Users, TrendingUp, TrendingDown, Minus } from 'lucide-react'
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

  // Quarterly data: filter by AE when selected
  const aeData = activeAE ? data?.byAE?.find(a => a.ae === activeAE) : null
  const displayQuarters = aeData ? aeData.byQuarter : (data?.byQuarter ?? [])
  const maxQuarterAcv = displayQuarters.reduce((max, q) => Math.max(max, q.acv), 0)

  // BKL-G17: reporting period range badge (e.g. "CY25 Q1–Q4")
  const QTR_FMT = /^[A-Z]{2}\d{2}Q\d$/
  const allQuarters = data?.byQuarter ?? []
  const reportingPeriod = allQuarters.length > 0 ? (() => {
    const validQ = allQuarters.filter(q => QTR_FMT.test(q.quarter))
    if (!validQ.length) return null
    const sorted = [...validQ].sort((a, b) => a.quarter.localeCompare(b.quarter))
    const first = sorted[0].quarter   // e.g. "CY25Q1"
    const last  = sorted[sorted.length - 1].quarter
    if (first === last) return first.replace(/Q(\d)/, ' Q$1')
    const year = first.slice(0, 4)
    const q1 = first.slice(5)
    const q2 = last.slice(5)
    const sameYear = first.slice(0, 4) === last.slice(0, 4)
    return sameYear
      ? `${year} ${q1}–${q2}`
      : `${first.replace(/Q(\d)/, ' Q$1')} – ${last.replace(/Q(\d)/, ' Q$1')}`
  })() : null

  // Top accounts: filter by AE when selected
  const displayedAccounts = activeAE
    ? (aeData?.topAccounts ?? [])
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
          <p className="text-sm text-text-secondary">No cloud spend data yet.</p>
          <p className="text-xs text-text-secondary">Run a CCSP scrape in Setup to populate.</p>
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
                        <span className="text-text-secondary">{fmt(acv)} · {pct.toFixed(0)}%</span>
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

        {/* Middle: AE selector + quarterly revenue bars */}
        <div className="bg-surface border border-border rounded-xl p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Users className="w-3.5 h-3.5 text-accent" />
            <span className="text-xs font-medium text-text-secondary">Quarterly Revenue</span>
            {activeAE && (
              <span className="text-xs text-accent font-medium ml-1">({activeAE})</span>
            )}
          </div>

          {/* AE selector row */}
          {(data?.byAE?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setActiveAE(null)}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  activeAE === null
                    ? 'bg-accent text-white border-accent'
                    : 'bg-transparent text-text-secondary border-border hover:border-text-secondary'
                }`}
              >
                All
              </button>
              {data?.byAE?.map(({ ae }) => (
                <button
                  key={ae}
                  onClick={() => setActiveAE(activeAE === ae ? null : ae)}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                    activeAE === ae
                      ? 'bg-accent text-white border-accent'
                      : 'bg-transparent text-text-secondary border-border hover:border-text-secondary'
                  }`}
                >
                  {ae.split(' ')[0]}
                </button>
              ))}
            </div>
          )}

          {/* Quarterly bars */}
          {loading ? (
            <div className="space-y-2 flex-1">
              {[1, 2, 3, 4].map((i) => <div key={i} className="h-5 bg-border rounded animate-pulse-slow" />)}
            </div>
          ) : displayQuarters.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-xs text-text-secondary">No quarterly data</div>
          ) : (
            <div className="space-y-2 flex-1">
              {activeAE && aeData && (
                <div className="text-lg font-bold text-text-primary tabular-nums mb-1">{fmt(aeData.acv)}</div>
              )}
              {displayQuarters.map(({ quarter, acv }, idx) => {
                const pct = maxQuarterAcv > 0 ? (acv / maxQuarterAcv) * 100 : 0
                const prev = displayQuarters[idx - 1]
                const trend = prev
                  ? acv > prev.acv * 1.02 ? 'up' : acv < prev.acv * 0.98 ? 'down' : 'flat'
                  : null
                return (
                  <div key={quarter}>
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="text-text-primary font-medium">{quarter.replace(/Q(\d)/, ' Q$1')}</span>
                      <span className="flex items-center gap-1 text-text-secondary font-mono">
                        {trend === 'up'   && <TrendingUp   className="w-3 h-3 text-green-500" />}
                        {trend === 'down' && <TrendingDown className="w-3 h-3 text-red-400" />}
                        {trend === 'flat' && <Minus        className="w-3 h-3 text-text-secondary opacity-50" />}
                        {fmt(acv)}
                      </span>
                    </div>
                    <div className="h-1.5 bg-border rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Right: Top accounts (filtered by AE when selected) */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Building2 className="w-3.5 h-3.5 text-accent" />
            <span className="text-xs font-medium text-text-secondary">
              Top Accounts{activeAE ? ` (${activeAE})` : ''}
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
                const maxAcv = displayedAccounts[0]?.acv ?? 1
                const pct = (acv / maxAcv) * 100
                const color = ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]
                return (
                  <div key={name}>
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <Link
                        to={`/dashboard/customer/${encodeURIComponent(shortName(name))}`}
                        className="text-text-primary truncate flex-1 mr-2 hover:underline"
                      >
                        {i + 1}. {shortName(name)}
                      </Link>
                      <span className="text-text-secondary shrink-0 font-mono">{fmt(acv)}</span>
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
