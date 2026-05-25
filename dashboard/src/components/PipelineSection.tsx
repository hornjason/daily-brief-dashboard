import { useState, useEffect } from 'react'
import { TrendingUp, Calendar, Users, X, RefreshCw, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react'
import type { PipelineSummary, PipelineOpp, PipelineByQuarterStage } from '../types'
import { formatRelTime, fmtCurrency as fmt } from '../lib/format'
import { normalizeProductName, stripProductName } from '../utils/productName'
import RelTime from './RelTime'
import Modal from './Modal'
import InlineSparkline from './InlineSparkline'

// BKL-INGEST-07: Staleness badge — show amber "Last synced Xh ago" when cache > 6h old.
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000  // 6 hours

function isCacheStale(cachedAt: string | null | undefined): boolean {
  if (!cachedAt) return false
  return Date.now() - new Date(cachedAt).getTime() > STALE_THRESHOLD_MS
}

/** Build a rolling 4-quarter ACV series for a single owner from their opp close dates. */
function ownerQuarterSeries(opps: PipelineOpp[], owner: string): { series: number[]; labels: string[] } {
  const qMap = new Map<string, number>()
  for (const o of opps) {
    if (o.owner !== owner || !o.closeDate) continue
    const d = new Date(o.closeDate)
    if (Number.isNaN(d.getTime())) continue
    const q = `${d.getFullYear()}-Q${Math.ceil((d.getMonth() + 1) / 3)}`
    qMap.set(q, (qMap.get(q) ?? 0) + o.acv)
  }
  const sortedKeys = [...qMap.keys()].sort((a, b) => a.localeCompare(b))
  const recent = sortedKeys.slice(-4)
  return {
    series: recent.map(k => qMap.get(k) ?? 0),
    labels: recent,
  }
}

function trendDelta(series: number[]): number | null {
  if (series.length < 2) return null
  const firstNonZeroIdx = series.findIndex(v => v > 0)
  if (firstNonZeroIdx < 0) return null
  const first = series[firstNonZeroIdx]
  const last = series[series.length - 1]
  if (first === 0) return null
  const raw = ((last - first) / first) * 100
  // Cap at +/-999% to avoid absurd display values from tiny base amounts
  return Math.max(-999, Math.min(999, raw))
}

function fmtDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function closeDateUrgency(iso: string): 'overdue' | 'urgent' | 'soon' | 'ok' {
  if (!iso) return 'ok'
  const days = (new Date(iso).getTime() - Date.now()) / 86_400_000
  if (days < 0) return 'overdue'
  if (days <= 30) return 'urgent'
  if (days <= 90) return 'soon'
  return 'ok'
}

const URGENCY_COLORS: Record<string, string> = {
  overdue: 'text-critical',
  urgent:  'text-warning',
  soon:    'text-accent',
  ok:      'text-text-secondary',
}

const STAGE_COLORS: Record<string, string> = {
  Commit:       '#3FB950',
  'Best Case':  '#D29922',
  Pipeline:     '#58A6FF',
  Closed:       '#A371F7',
  Omitted:      '#6B7280',
}

function firstNames(full: string): string {
  return full.split(' ')[0]
}

export function OppDetail({ opp, onClose }: { opp: PipelineOpp; onClose: () => void }) {
  const stageColor = STAGE_COLORS[opp.forecastCategory] ?? STAGE_COLORS.Omitted
  const urgency = closeDateUrgency(opp.closeDate)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-sm p-5 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-text-secondary mb-0.5">{opp.accountName}</p>
            {opp.oppId ? (
              <a
                href={`https://redhatcrm.lightning.force.com/lightning/r/Opportunity/${opp.oppId}/view`}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-semibold text-blue-400 hover:text-blue-300 leading-snug hover:underline"
              >
                {opp.oppName}
              </a>
            ) : (
              <p className="text-sm font-semibold text-text-primary leading-snug">{opp.oppName}</p>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 text-text-secondary hover:text-text-primary transition-colors mt-0.5" role="button" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ACV */}
        <div className="text-3xl font-bold text-text-primary tabular-nums">{fmt(opp.acv)}</div>

        {/* Key fields grid */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-border/30 rounded-lg p-2.5">
            <p className="text-xs text-text-secondary mb-0.5">Stage</p>
            <p className="text-sm font-semibold" style={{ color: stageColor }}>{opp.forecastCategory}</p>
          </div>
          <div className="bg-border/30 rounded-lg p-2.5">
            <p className="text-xs text-text-secondary mb-0.5">Close Date</p>
            <p className={`text-sm font-semibold ${URGENCY_COLORS[urgency]}`}>
              {opp.closeDate ? new Date(opp.closeDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
            </p>
          </div>
          <div className="bg-border/30 rounded-lg p-2.5">
            <p className="text-xs text-text-secondary mb-0.5">Probability</p>
            <p className="text-sm font-semibold text-text-primary">{opp.probability}%</p>
          </div>
          <div className="bg-border/30 rounded-lg p-2.5">
            <p className="text-xs text-text-secondary mb-0.5">Type</p>
            <p className="text-sm font-semibold text-text-primary">{opp.renewal ? '↻ Renewal' : '✦ New Business'}</p>
          </div>
          {opp.offeringGroup && (
            <div className="bg-border/30 rounded-lg p-2.5">
              <p className="text-xs text-text-secondary mb-0.5">Offering</p>
              <p className="text-sm font-semibold text-text-primary">{opp.offeringGroup}</p>
            </div>
          )}
          <div className="bg-border/30 rounded-lg p-2.5">
            <p className="text-xs text-text-secondary mb-0.5">Owner</p>
            <p className="text-sm font-semibold text-text-primary">{opp.owner.split(' ')[0]}</p>
          </div>
        </div>

        {opp.products.length > 0 && (
          <div>
            <p className="text-xs font-medium text-text-secondary mb-1.5">Products</p>
            <ul className="space-y-1">
              {opp.products.map((p, i) => (
                <li key={i} className="flex gap-2 text-xs text-text-secondary">
                  <span className="text-accent mt-0.5 shrink-0">·</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-text-secondary/65">Opp #{opp.oppNumber}</p>
      </div>
    </div>
  )
}

/** Check whether an opp's product list contains at least one product matching a selected label */
function oppMatchesProducts(opp: PipelineOpp, selectedProducts: string[]): boolean {
  if (selectedProducts.length === 0) return true
  return opp.products.some(raw => selectedProducts.includes(normalizeProductName(stripProductName(raw))))
}

interface Props {
  data: PipelineSummary | null
  loading: boolean
  error?: string | null
  onRefresh?: () => void
  selectedProducts?: string[]
  aeFilterSelected?: string
  /** BKL-UX119: bubble "By Owner" row clicks up to the global AE filter so the
   *  left-panel totals/bars repaint. Without this, internal activeOwner state
   *  only affects this section's right column. */
  onSelectOwner?: (owner: string | null) => void
}

export function PipelineSection({ data, loading, error, onRefresh, selectedProducts = [], aeFilterSelected, onSelectOwner }: Props) {
  const [activeOwner, setActiveOwner] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<'acv' | 'date' | 'stage'>('acv')
  const [selectedOpp, setSelectedOpp] = useState<PipelineOpp | null>(null)

  // BKL-UX120: Sync activeOwner with global AE filter so the "By Owner" tile
  // shows the clear button and "{Owner}'s Opps" header when the filter is set
  // externally (e.g. via CCSP tile click). Mirrors the BKL-UX118 pattern in
  // CloudSpendSection.
  useEffect(() => {
    if (!aeFilterSelected || aeFilterSelected === 'all') {
      setActiveOwner(null)
      return
    }
    const matched = data?.byOwner?.find(o => o.owner?.toLowerCase() === aeFilterSelected.toLowerCase())?.owner ?? null
    setActiveOwner(matched)
  }, [aeFilterSelected, data])

  const productActive = selectedProducts.length > 0

  // Apply product filter to opp lists
  const allTopOpps     = data?.topOpps        ?? []
  const allClosedOpps  = data?.closedOpps     ?? []
  const topOpps        = productActive ? allTopOpps.filter(o => oppMatchesProducts(o, selectedProducts)) : allTopOpps
  const closedOpps     = productActive ? allClosedOpps.filter(o => oppMatchesProducts(o, selectedProducts)) : allClosedOpps

  // Recompute summary stats from filtered opps when product filter is active
  const totalAcv       = productActive ? topOpps.reduce((s, o) => s + o.acv, 0) : (data?.totalAcv ?? 0)
  const openCount      = productActive ? topOpps.length : (data?.openCount ?? 0)
  const renewalAcv     = productActive ? topOpps.filter(o => o.renewal).reduce((s, o) => s + o.acv, 0) : (data?.renewalAcv ?? 0)
  const newAcv         = productActive ? topOpps.filter(o => !o.renewal).reduce((s, o) => s + o.acv, 0) : (data?.newAcv ?? 0)
  const byOwner        = data?.byOwner        ?? []

  // Recompute byStage from filtered opps when product filter is active
  const byStage = productActive ? (() => {
    const stageMap = new Map<string, { acv: number; count: number }>()
    for (const o of topOpps) {
      const slot = stageMap.get(o.forecastCategory) ?? { acv: 0, count: 0 }
      slot.acv += o.acv
      slot.count += 1
      stageMap.set(o.forecastCategory, slot)
    }
    return [...stageMap.entries()].map(([stage, { acv, count }]) => ({ stage, acv, count }))
  })() : (data?.byStage ?? [])

  const maxStageAcv = byStage.reduce((m, s) => Math.max(m, s.acv), 0)
  const maxOwnerAcv = byOwner.reduce((m, o) => Math.max(m, o.acv), 0)

  const ownerOpps = activeOwner ? topOpps.filter(o => o.owner === activeOwner) : topOpps
  const ownerClosed = activeOwner ? closedOpps.filter(o => o.owner === activeOwner) : closedOpps

  // Quarterly stage breakdown — open + closed, reactive to selected owner
  const byQuarterStage = (() => {
    const qMap = new Map<string, { commit: number; bestCase: number; pipeline: number; closed: number }>()
    for (const o of [...ownerOpps, ...ownerClosed]) {
      if (!o.closeDate) continue
      const d = new Date(o.closeDate)
      const q = `Q${Math.ceil((d.getMonth() + 1) / 3)} ${d.getFullYear()}`
      const slot = qMap.get(q) ?? { commit: 0, bestCase: 0, pipeline: 0, closed: 0 }
      if (o.forecastCategory === 'Commit')         slot.commit   += o.acv
      else if (o.forecastCategory === 'Best Case') slot.bestCase += o.acv
      else if (o.forecastCategory === 'Pipeline')  slot.pipeline += o.acv
      else if (o.forecastCategory === 'Closed')    slot.closed   += o.acv
      qMap.set(q, slot)
    }
    return [...qMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([quarter, v]) => ({ quarter, ...v }))
  })()

  const STAGE_SORT_ORDER: Record<string, number> = { Commit: 0, 'Best Case': 1, Pipeline: 2, Omitted: 3 }

  const sortedOwnerOpps = [...ownerOpps].sort((a, b) => {
    if (sortBy === 'date')  return (a.closeDate ?? '').localeCompare(b.closeDate ?? '')
    if (sortBy === 'stage') return (STAGE_SORT_ORDER[a.forecastCategory] ?? 9) - (STAGE_SORT_ORDER[b.forecastCategory] ?? 9)
    return b.acv - a.acv  // 'acv' default
  })

  const filteredOpps: PipelineOpp[] = sortedOwnerOpps

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden" data-testid="pipeline-tile">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-border flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Open Pipeline</h2>
        <span className="text-xs text-text-secondary">Opportunities 2026</span>
        {loading && <span className="text-xs text-text-secondary animate-pulse">Loading…</span>}
        {!loading && (
          <span className="text-xs text-text-secondary ml-auto flex items-center gap-2">
            {/* BKL-INGEST-07: Staleness badge — amber pill when cache > 6h old */}
            {data?.cachedAt && isCacheStale(data.cachedAt) && (
              <span
                className="text-xs font-medium text-warning bg-warning/10 border border-warning/25 rounded-full px-2 py-0.5 flex items-center gap-1"
                title="Data may be outdated — sync is running in the background"
                data-testid="pipeline-stale-badge"
              >
                <AlertCircle className="w-3 h-3" />
                <RelTime iso={data.cachedAt} className="" />
              </span>
            )}
            {data?.cachedAt && !isCacheStale(data.cachedAt) && (
              <RelTime iso={data.cachedAt} className="text-xs text-text-secondary" />
            )}
            {!data?.cachedAt && 'Live'}
          </span>
        )}
        {onRefresh && (
          <button onClick={onRefresh} className="ml-auto text-text-secondary hover:text-text-primary transition-colors shrink-0" title="Refresh" aria-label="Refresh pipeline data">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {error && !loading && (
        <div className="flex items-center gap-2 text-xs text-critical px-5 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Failed to load pipeline data. {onRefresh && <button onClick={onRefresh} className="underline hover:no-underline">Retry</button>}</span>
        </div>
      )}

      <div className="p-5 grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Left: totals + stage breakdown */}
        <div className="bg-surface border border-border rounded-xl p-4 flex flex-col gap-4">
          {/* Total ACV */}
          <div>
            <div className="text-xs text-text-secondary mb-1">Total Open ACV</div>
            {loading ? (
              <div className="h-8 w-28 bg-border rounded animate-pulse-slow" />
            ) : (
              <div className="text-3xl font-bold text-text-primary tabular-nums">{fmt(totalAcv)}</div>
            )}
            <div className="text-xs text-text-secondary">{openCount} opportunities</div>
          </div>

          {/* New vs Renewal */}
          {!loading && (
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-border/30 rounded-lg p-2.5">
                <div className="text-xs text-text-secondary mb-0.5">New Business</div>
                <div className="text-sm font-semibold text-text-primary">{fmt(newAcv)}</div>
              </div>
              <div className="bg-border/30 rounded-lg p-2.5">
                <div className="text-xs text-text-secondary mb-0.5">Renewal</div>
                <div className="text-sm font-semibold text-text-primary">{fmt(renewalAcv)}</div>
              </div>
            </div>
          )}

          {/* By forecast stage */}
          <div>
            <div className="text-xs font-medium text-text-secondary mb-2">By Forecast Stage</div>
            {loading
              ? [1, 2, 3].map(i => <div key={i} className="h-5 bg-border rounded animate-pulse-slow mb-2" />)
              : byStage.map(({ stage, acv, count }) => {
                const pct = maxStageAcv > 0 ? (acv / maxStageAcv) * 100 : 0
                const color = STAGE_COLORS[stage] ?? STAGE_COLORS.Omitted
                return (
                  <div key={stage} className="mb-2">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-text-primary font-medium">{stage}</span>
                      <span className="text-text-secondary">{fmt(acv)} · {count}</span>
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

        {/* Middle: By owner */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-3.5 h-3.5 text-accent" />
            <span className="text-sm font-medium text-text-secondary">By Owner</span>
            {activeOwner && (
              <button onClick={() => { setActiveOwner(null); onSelectOwner?.(null) }} className="ml-auto text-xs text-text-secondary hover:text-text-primary transition-colors" aria-label="Clear owner filter">
                clear
              </button>
            )}
          </div>
          {loading ? (
            <div className="space-y-2">
              {[1,2,3,4].map(i => <div key={i} className="h-8 bg-border rounded animate-pulse-slow" />)}
            </div>
          ) : byOwner.length > 0 ? (
            /* ── Compact sparkline rows — permanent default regardless of owner count ───────────── */
            <div className="space-y-1" data-testid="pipeline-owner-compact">
              {byOwner.map(({ owner, acv, count }) => {
                const isActive = activeOwner === owner
                const { series } = ownerQuarterSeries(topOpps, owner)
                const delta = trendDelta(series)
                const deltaColor =
                  delta === null ? 'text-text-secondary/65'
                  : delta > 0 ? 'text-success'
                  : delta < 0 ? 'text-critical'
                  : 'text-text-secondary'
                return (
                  <button
                    key={owner}
                    onClick={() => {
                      const next = isActive ? null : owner
                      setActiveOwner(next)
                      onSelectOwner?.(next)
                    }}
                    className={`w-full flex items-center gap-2 text-left rounded px-2 py-1.5 transition-colors ${isActive ? 'bg-border/40' : 'hover:bg-border/20'}`}
                    data-testid="pipeline-owner-compact-row"
                    aria-expanded={isActive}
                  >
                    {isActive ? (
                      <ChevronDown className="w-3 h-3 text-text-secondary shrink-0" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-text-secondary shrink-0" />
                    )}
                    <span className={`text-xs font-medium truncate min-w-0 flex-1 ${isActive ? 'text-text-primary' : 'text-text-secondary'}`} title={owner}>
                      {firstNames(owner)}
                    </span>
                    <span className="text-xs text-text-primary shrink-0 tabular-nums font-mono">{fmt(acv)}</span>
                    <InlineSparkline values={series} width={40} height={12} />
                    <span className="text-[11px] text-text-secondary shrink-0 tabular-nums">{count}</span>
                    <span className={`text-[11px] shrink-0 tabular-nums w-12 text-right ${deltaColor}`}>
                      {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="space-y-2">
              {byOwner.map(({ owner, acv, count }) => {
                const pct = maxOwnerAcv > 0 ? (acv / maxOwnerAcv) * 100 : 0
                const isActive = activeOwner === owner
                return (
                  <button
                    key={owner}
                    onClick={() => {
                      const next = isActive ? null : owner
                      setActiveOwner(next)
                      onSelectOwner?.(next)
                    }}
                    className={`w-full text-left rounded px-2 py-1.5 transition-colors ${isActive ? 'bg-border/40' : 'hover:bg-border/20'}`}
                  >
                    <div className="flex justify-between text-sm mb-1">
                      <span className={`font-medium ${isActive ? 'text-text-primary' : 'text-text-secondary'}`}>
                        {firstNames(owner)}
                      </span>
                      <span className="text-xs text-text-secondary">{fmt(acv)} · {count}</span>
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
          )}

          {/* Quarter × Stage grid — compact is now the permanent default, so the grid
              only shows when a specific owner is selected (acts as the inline expansion detail) */}
          {!loading && byQuarterStage.length > 0 && activeOwner !== null && (
            <div className="mt-3 pt-3 border-t border-border/50">
              <div className="grid grid-cols-5 gap-x-1 mb-1.5">
                <span className="text-xs text-text-secondary"></span>
                <span className="text-xs font-medium text-center" style={{ color: STAGE_COLORS['Commit'] }}>Commit</span>
                <span className="text-xs font-medium text-center" style={{ color: STAGE_COLORS['Best Case'] }}>Best</span>
                <span className="text-xs font-medium text-center" style={{ color: STAGE_COLORS['Pipeline'] }}>Pipeline</span>
                <span className="text-xs font-medium text-center" style={{ color: STAGE_COLORS['Closed'] }}>Closed</span>
              </div>
              {byQuarterStage.map(({ quarter, commit, bestCase, pipeline, closed }) => (
                <div key={quarter} className="grid grid-cols-5 gap-x-1 py-0.5 hover:bg-border/20 rounded px-1 -mx-1">
                  <span className="text-xs text-text-secondary font-medium">{quarter}</span>
                  <span className="text-xs text-text-primary text-center font-mono">{commit > 0 ? fmt(commit) : <span className="text-text-secondary/65">—</span>}</span>
                  <span className="text-xs text-text-primary text-center font-mono">{bestCase > 0 ? fmt(bestCase) : <span className="text-text-secondary/65">—</span>}</span>
                  <span className="text-xs text-text-primary text-center font-mono">{pipeline > 0 ? fmt(pipeline) : <span className="text-text-secondary/65">—</span>}</span>
                  <span className="text-xs text-text-primary text-center font-mono">{closed > 0 ? fmt(closed) : <span className="text-text-secondary/65">—</span>}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Top opps */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Calendar className="w-3.5 h-3.5 text-accent" />
            <span className="text-sm font-medium text-text-secondary">
              {activeOwner ? `${firstNames(activeOwner)}'s Opps` : 'Top Opportunities'}
            </span>
            <div className="ml-auto flex items-center gap-0.5 bg-border/30 rounded-md p-0.5">
              {(['acv', 'date', 'stage'] as const).map(opt => (
                <button
                  key={opt}
                  onClick={() => setSortBy(opt)}
                  className={`text-xs px-1.5 py-0.5 rounded transition-colors ${sortBy === opt ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
                >
                  {opt === 'acv' ? '$' : opt === 'date' ? 'Date' : 'Stage'}
                </button>
              ))}
            </div>
          </div>
          {loading ? (
            <div className="space-y-2">
              {[1,2,3,4,5].map(i => <div key={i} className="h-10 bg-border rounded animate-pulse-slow" />)}
            </div>
          ) : filteredOpps.length === 0 ? (
            <div className="text-xs text-text-secondary">No opportunities</div>
          ) : (
            <div className="overflow-y-auto max-h-64">
              {filteredOpps.map((opp) => {
                const urgency = closeDateUrgency(opp.closeDate)
                const stageColor = STAGE_COLORS[opp.forecastCategory] ?? STAGE_COLORS.Omitted
                return (
                  <button key={opp.oppNumber} onClick={() => setSelectedOpp(opp)} className="w-full text-left flex items-center gap-2 py-1 px-1 -mx-1 hover:bg-border/20 rounded group cursor-pointer min-w-0" tabIndex={0}>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: stageColor }} />
                    <span className="text-xs font-medium shrink-0 w-14" style={{ color: stageColor }}>
                      {opp.forecastCategory === 'Best Case' ? 'Best' : opp.forecastCategory}
                    </span>
                    <span className="text-sm text-text-primary truncate flex-1 min-w-0" title={opp.accountName}>{opp.accountName}</span>
                    <span className={`text-xs shrink-0 ${URGENCY_COLORS[urgency]}`}>{fmtDate(opp.closeDate)}</span>
                    <span className="text-xs font-mono text-text-primary shrink-0">{fmt(opp.acv)}</span>
                    {opp.renewal && <span className="text-xs text-text-secondary/75 shrink-0">↻</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>

      </div>

      {selectedOpp && <OppDetail opp={selectedOpp} onClose={() => setSelectedOpp(null)} />}
    </div>
  )
}
