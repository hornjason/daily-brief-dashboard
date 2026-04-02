import { useState } from 'react'
import type { CCSPSummary, CCSPCustomer } from '../types'
import { formatRelTime, fmtCurrency as fmt, fmtCurrencyFull as fmtFull } from '../lib/format'
import RelTime from './RelTime'
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Sector,
} from 'recharts'
import { Cloud, Building2, RefreshCw, AlertCircle } from 'lucide-react'
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

// Custom active donut sector — expands outward on hover/select
function renderActiveShape(props: any) {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = props
  return (
    <g>
      <Sector
        cx={cx} cy={cy}
        innerRadius={innerRadius - 2}
        outerRadius={outerRadius + 6}
        startAngle={startAngle}
        endAngle={endAngle}
        fill={fill}
        opacity={1}
      />
    </g>
  )
}

interface DonutCenterProps {
  cx: number
  cy: number
  selected: CCSPCustomer | null
  totalAcv: number
}

function DonutCenter({ cx, cy, selected, totalAcv }: DonutCenterProps) {
  if (selected) {
    const pct = totalAcv > 0 ? ((selected.acv / totalAcv) * 100).toFixed(1) : '0'
    return (
      <g>
        <text x={cx} y={cy - 22} textAnchor="middle" fill="var(--color-text-secondary)" fontSize={9}>
          {shortName(selected.name).length > 16
            ? shortName(selected.name).slice(0, 15) + '…'
            : shortName(selected.name)}
        </text>
        <text x={cx} y={cy - 6} textAnchor="middle" fill="var(--color-text-primary)" fontSize={15} fontWeight="bold">
          {fmt(selected.acv)}
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill="var(--color-text-secondary)" fontSize={9}>
          {pct}% of portfolio
        </text>
        {selected.partners.slice(0, 2).map((p, i) => (
          <text key={p.partner} x={cx} y={cy + 24 + i * 12} textAnchor="middle" fill="var(--color-text-secondary)" fontSize={8}>
            {p.partner} {fmt(p.acv)}
          </text>
        ))}
      </g>
    )
  }
  return (
    <g>
      <text x={cx} y={cy - 8} textAnchor="middle" fill="var(--color-text-secondary)" fontSize={9}>Total Portfolio</text>
      <text x={cx} y={cy + 10} textAnchor="middle" fill="var(--color-text-primary)" fontSize={16} fontWeight="bold">
        {fmt(totalAcv)}
      </text>
    </g>
  )
}

interface Props {
  data: CCSPSummary | null
  loading: boolean
  error?: string | null
  onRefresh?: () => void
}

export function CloudSpendSection({ data, loading, error, onRefresh }: Props) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)

  const customers = data?.byCustomer ?? []
  const partners = data?.byPartner ?? []
  const totalAcv = data?.totalAcv ?? 0

  const displayIndex = selectedIndex ?? activeIndex
  const selectedCustomer = displayIndex !== null ? (customers[displayIndex] ?? null) : null

  function handleClick(_: any, index: number) {
    setSelectedIndex(selectedIndex === index ? null : index)
  }

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Section header */}
      <div className="px-5 py-3.5 border-b border-border flex items-center gap-2">
        <Cloud className="w-4 h-4 text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Cloud Spend (CCSP)</h2>
        <span className="text-xs text-text-secondary">2025 Marketplace Revenue</span>
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

        {/* Middle: Account donut chart */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Building2 className="w-3.5 h-3.5 text-accent" />
            <span className="text-xs font-medium text-text-secondary">Spend by Account</span>
            {selectedIndex !== null && (
              <button
                onClick={() => setSelectedIndex(null)}
                className="ml-auto text-xs text-text-secondary hover:text-text-primary transition-colors"
                aria-label="Clear selection"
              >
                clear
              </button>
            )}
          </div>

          {loading ? (
            <div className="h-48 bg-border rounded animate-pulse-slow" />
          ) : customers.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-xs text-text-secondary">No data</div>
          ) : (
            <div className="flex gap-3">
              {/* Donut */}
              <div className="shrink-0" style={{ width: 180, height: 180 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={customers}
                      dataKey="acv"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={48}
                      outerRadius={72}
                      activeIndex={displayIndex ?? undefined}
                      activeShape={renderActiveShape}
                      onMouseEnter={(_, index) => { if (selectedIndex === null) setActiveIndex(index) }}
                      onMouseLeave={() => { if (selectedIndex === null) setActiveIndex(null) }}
                      onClick={handleClick}
                      strokeWidth={0}
                    >
                      {customers.map((_, i) => (
                        <Cell
                          key={i}
                          fill={ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]}
                          opacity={displayIndex === null || displayIndex === i ? 1 : 0.35}
                          style={{ cursor: 'pointer' }}
                        />
                      ))}
                    </Pie>
                    {/* Center label via custom element */}
                  </PieChart>
                </ResponsiveContainer>
                {/* Overlay center text — positioned absolute over the chart */}
              </div>

              {/* Legend */}
              <div className="flex-1 overflow-y-auto max-h-48 space-y-1 pr-1">
                {customers.map(({ name, acv }, i) => (
                  <button
                    key={name}
                    onClick={() => setSelectedIndex(selectedIndex === i ? null : i)}
                    className={`w-full flex items-center gap-1.5 text-left rounded px-1 py-0.5 transition-colors ${
                      displayIndex === i ? 'bg-border/40' : 'hover:bg-border/20'
                    }`}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: ACCOUNT_COLORS[i % ACCOUNT_COLORS.length] }}
                    />
                    <Link
                      to={`/dashboard/customer/${encodeURIComponent(shortName(name))}`}
                      onClick={(e) => e.stopPropagation()}
                      className={`text-xs truncate flex-1 hover:underline ${displayIndex === i ? 'text-text-primary font-medium' : 'text-text-secondary'}`}
                    >
                      {shortName(name)}
                    </Link>
                    <span className="text-xs text-text-secondary font-mono shrink-0">{fmt(acv)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Selected account detail — partner breakdown */}
          {selectedCustomer && (
            <div className="mt-3 pt-3 border-t border-border/50">
              <div className="text-xs text-text-secondary mb-1.5">{shortName(selectedCustomer.name)} — hyperscaler breakdown</div>
              <div className="space-y-1.5">
                {selectedCustomer.partners.map(({ partner, acv }) => {
                  const pct = selectedCustomer.acv > 0 ? (acv / selectedCustomer.acv) * 100 : 0
                  const color = PARTNER_COLORS[partner] ?? PARTNER_COLORS.Other
                  return (
                    <div key={partner}>
                      <div className="flex justify-between text-xs mb-0.5">
                        <span className="text-text-primary">{partner}</span>
                        <span className="text-text-secondary">{fmtFull(acv)} · {pct.toFixed(0)}%</span>
                      </div>
                      <div className="h-1 bg-border rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Right: Top accounts */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Building2 className="w-3.5 h-3.5 text-accent" />
            <span className="text-xs font-medium text-text-secondary">Top Accounts</span>
          </div>
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-5 bg-border rounded animate-pulse-slow" />)}
            </div>
          ) : customers.length === 0 ? (
            <div className="text-xs text-text-secondary">No data</div>
          ) : (
            <div className="space-y-2">
              {customers.slice(0, 10).map(({ name, acv }, i) => {
                const maxAcv = customers[0]?.acv ?? 1
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
